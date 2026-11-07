package expo.modules.t3speech

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.icu.text.BreakIterator
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.media.AudioAttributesCompat
import androidx.media.AudioFocusRequestCompat
import androidx.media.AudioManagerCompat
import java.io.File
import java.io.RandomAccessFile
import java.util.Locale
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.thread
import kotlin.concurrent.withLock

internal const val TAG = "T3Speech"

data class SpeechState(val block: Int?, val paused: Boolean)

internal class SpeechSettings(val voice: CloudVoice, val pace: Float, val title: String)

internal object SpeechPlayer {
  private class Reading(val session: SpeechSession, val thread: Thread)

  @Volatile private var current: Reading? = null
  val isReading get() = current != null

  /**
   * Ends the current reading even when the new one fails to start, so text sent for the new
   * one cannot reach it. The new reading plays once the old one has released its audio.
   */
  fun start(
    context: Context,
    settings: () -> SpeechSettings,
    onState: (SpeechState) -> Unit,
    done: (Result<Boolean>) -> Unit,
  ) {
    val previous = synchronized(this) { current.also { current = null } }
    previous?.session?.cancel()
    lateinit var reading: Reading
    try {
      val validated = settings()
      val session = SpeechSession(context, validated) { state ->
        if (current !== reading) return@SpeechSession
        SpeechService.update(state.paused)
        onState(state)
      }
      reading = Reading(session, thread(start = false, name = "T3Speech generation") {
        previous?.thread?.join()
        val result = runCatching { session.run() }
        synchronized(this) { if (current === reading) current = null }
        SpeechService.stop()
        done(result)
      })
      synchronized(this) {
        SpeechService.start(context, validated.title)
        current = reading
      }
    } catch (error: Exception) {
      SpeechService.stop()
      throw error
    }
    reading.thread.start()
  }

  private val session get() = current?.session

  fun append(blocks: List<String>, from: Int) = session?.append(blocks, from)
  fun finish() = session?.finish()
  fun rewind() = session?.rewind()
  fun nextBlock() = session?.nextBlock()
  fun seekToBlock(block: Int) = session?.seekToBlock(block)
  fun pause() = session?.pause()
  fun resume() = session?.resume()
  fun togglePause() = session?.togglePause()
  fun setPace(pace: Float) = session?.setPace(pace)

  fun stop(stopped: () -> Unit) {
    val reading = current ?: return stopped()
    reading.session.cancel()
    thread(name = "T3Speech stop") {
      reading.thread.join()
      stopped()
    }
  }
}

private enum class ResumePoint { POSITION, BLOCK_START, REWOUND }

/**
 * Every generated sample goes to a temporary PCM file, so rewinding and seeking replay audio
 * instead of regenerating it. `lock` guards all state, and every change signals `changed`.
 * Only the playback thread touches the AudioTrack; it restarts the track when `epoch` changes.
 */
private class SpeechSession(
  private val context: Context,
  settings: SpeechSettings,
  private val onState: (SpeechState) -> Unit,
) {
  private val lock = ReentrantLock()
  private val changed = lock.newCondition()
  private val voice = settings.voice
  private val cacheFile = File(context.cacheDir, "t3-speech-${UUID.randomUUID()}.pcm")
  private var cache: RandomAccessFile? = null
  private val audioManager = context.getSystemService(AudioManager::class.java)
  private val focus = AudioFocusRequestCompat.Builder(AudioManagerCompat.AUDIOFOCUS_GAIN)
    .setAudioAttributes(
      AudioAttributesCompat.Builder()
        .setUsage(AudioAttributesCompat.USAGE_MEDIA)
        .setContentType(AudioAttributesCompat.CONTENT_TYPE_SPEECH)
        .build(),
    )
    .setOnAudioFocusChangeListener(::focusChanged)
    .build()
  private val noisy = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      Log.i(TAG, "audio becoming noisy")
      pause(ResumePoint.BLOCK_START)
    }
  }

  private var blocks = listOf<String>()
  private var inputFinished = false
  private var nextIndex = 0
  /** Bumped when generation jumps to another block; audio from an older generation is dropped. */
  private var generation = 0
  private var generationIdle = false
  /**
   * Blocks from `contiguousFrom` up to the one being generated play back to back in the cache,
   * starting at `runStart`.
   */
  private var contiguousFrom = 0
  private var runStart = 0L
  private val marks = mutableListOf<Pair<Long, Int>>()

  private var writtenFrames = 0L
  /** The next cached frame the playback thread writes to the track. */
  private var playFrame = 0L
  private var epoch = 0
  private var trackEpoch = -1
  private var track: AudioTrack? = null
  /** The cached frame at the track's head position 0. */
  private var trackStart = 0L
  private var pace = settings.pace
  private var paused = false
  /** Set while an interruption holds the reading, so its end resumes only that pause. */
  private var interrupted = false
  private var resumeFrame = 0L
  private var publishedBlock: Int? = null

  private var segmentFirstAudio: Long? = null
  private var segmentWaited = 0L
  private var starvedAt: Long? = null

  private var cancelled = false
  private var ended = false
  private var failure: Exception? = null

  /** Returns true when the reading played to the end, false when it was cancelled. */
  fun run(): Boolean {
    lock.withLock { if (cancelled) return false }
    try {
      openAudio()
      Log.i(TAG, "start ${voice.model} voice ${voice.voice} pace $pace")
      val player = thread(name = "T3Speech playback") { play() }
      try {
        generate()
      } catch (error: Exception) {
        lock.withLock { fail(error) }
      }
      player.join()
      lock.withLock {
        failure?.let { throw it }
        return !cancelled
      }
    } finally {
      close()
    }
  }

  private fun generate() {
    while (true) {
      val (index, text, generation) = takeBlock() ?: return
      lock.withLock { if (generation == this.generation) marks.add(writtenFrames to index) }
      for (segment in speechSegments(text, CloudVoice.SEGMENT_LENGTH)) {
        if (!isCurrent(generation)) break
        val started = SystemClock.elapsedRealtime()
        val framesBefore = lock.withLock {
          segmentFirstAudio = null
          segmentWaited = 0
          writtenFrames
        }
        try {
          voice.generate(segment) { append(it, generation) }
        } catch (error: Exception) {
          Log.e(TAG, "block $index segment failed: ${error.message}")
          if (isCurrent(generation)) throw error
        }
        logSegment(index, segment.length, started, framesBefore, generation)
      }
    }
  }

  /** A changed block that was already generated is read again from its start. */
  fun append(texts: List<String>, from: Int) = lock.withLock {
    blocks = blocks.take(from) + texts
    generationIdle = false
    if (from < nextIndex) regenerateLocked(from)
    changed.signalAll()
  }

  fun finish() = lock.withLock {
    inputFinished = true
    changed.signalAll()
  }

  private fun takeBlock(): Triple<Int, String, Int>? {
    lock.withLock {
      while (true) {
        if (cancelled || ended) return null
        if (nextIndex < blocks.size) {
          nextIndex += 1
          return Triple(nextIndex - 1, blocks[nextIndex - 1], generation)
        }
        if (inputFinished && !generationIdle) {
          generationIdle = true
          changed.signalAll()
        }
        changed.await()
      }
    }
  }

  private fun isCurrent(generation: Int) = lock.withLock { !cancelled && generation == this.generation }

  /** Returns false when generation should stop: the session ended or jumped to another block. */
  private fun append(pcm: ByteArray, generation: Int): Boolean = lock.withLock {
    while (true) {
      if (cancelled || generation != this.generation) return false
      if (pcm.isEmpty()) return true
      if (writtenFrames - position() < LOOKAHEAD_FRAMES) break
      val waitStarted = SystemClock.elapsedRealtime()
      changed.await()
      segmentWaited += SystemClock.elapsedRealtime() - waitStarted
    }
    if (segmentFirstAudio == null) segmentFirstAudio = SystemClock.elapsedRealtime()
    val cache = cache!!
    cache.seek(writtenFrames * 2)
    cache.write(pcm)
    writtenFrames += pcm.size / 2
    changed.signalAll()
    true
  }

  /**
   * Generation speed excludes time spent waiting for playback to make room, so a rate below the
   * playback pace means playback will run out of audio.
   */
  private fun logSegment(block: Int, characters: Int, started: Long, framesBefore: Long, generation: Int): Unit = lock.withLock {
    if (generation != this.generation) return
    val audio = (writtenFrames - framesBefore).toDouble() / CloudVoice.SAMPLE_RATE
    val working = (SystemClock.elapsedRealtime() - started - segmentWaited) / 1_000.0
    val firstAudio = segmentFirstAudio?.let { it - started } ?: -1
    val ahead = (writtenFrames - position()).toDouble() / CloudVoice.SAMPLE_RATE
    Log.i(
      TAG,
      "block $block segment $characters chars: %.1fs audio in %.1fs (%.2fx), first audio ${firstAudio}ms, waited %.1fs, %.1fs buffered"
        .format(audio, working, audio / maxOf(working, 0.001), segmentWaited / 1_000.0, ahead),
    )
  }

  fun rewind(): Unit = lock.withLock {
    if (cancelled || ended) return
    Log.i(TAG, "rewind")
    val target = maxOf(runStart, position() - CloudVoice.SAMPLE_RATE * 10L)
    if (paused) resumeFrame = target else seekLocked(target)
    publishBlock(target)
  }

  fun nextBlock() {
    val block = lock.withLock { currentBlock() }
    seekToBlock((block ?: -1) + 1)
  }

  fun seekToBlock(block: Int): Unit = lock.withLock {
    if (cancelled || ended || block < 0) return
    Log.i(TAG, "seek to block $block")
    val start = if (block in contiguousFrom until nextIndex) marks.lastOrNull { it.second == block }?.first else null
    if (start == null) return regenerateLocked(block)
    if (paused) resumeFrame = start else seekLocked(start)
    publishedBlock = block
    onState(SpeechState(block, paused))
  }

  private fun regenerateLocked(block: Int) {
    Log.i(TAG, "regenerate from block $block")
    generation += 1
    nextIndex = block
    contiguousFrom = block
    runStart = writtenFrames
    generationIdle = false
    if (paused) resumeFrame = writtenFrames else seekLocked(writtenFrames)
    publishedBlock = block
    onState(SpeechState(block, paused))
    changed.signalAll()
  }

  fun pause() = pause(ResumePoint.POSITION)

  private fun pause(point: ResumePoint) = lock.withLock {
    interrupted = false
    pauseLocked(point)
  }

  fun resume() = lock.withLock { resumeLocked() }

  fun togglePause() = lock.withLock {
    if (paused) resumeLocked() else pauseLocked(ResumePoint.POSITION)
  }

  fun setPace(pace: Float) = lock.withLock {
    this.pace = pace
    changed.signalAll()
  }

  private fun focusChanged(change: Int) {
    Log.i(TAG, "audio focus change $change")
    lock.withLock {
      when (change) {
        // Android does not duck speech for another app; it asks the reader to pause instead.
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> if (!paused) {
          pauseLocked(ResumePoint.REWOUND)
          interrupted = paused
        }
        AudioManager.AUDIOFOCUS_LOSS -> {
          interrupted = false
          pauseLocked(ResumePoint.REWOUND)
        }
        AudioManager.AUDIOFOCUS_GAIN -> {
          if (interrupted) resumeLocked()
          interrupted = false
        }
      }
    }
  }

  private fun pauseLocked(point: ResumePoint) {
    if (cancelled || ended || paused) return
    starvedAt = null
    Log.i(TAG, "pause")
    val position = position()
    resumeFrame = when (point) {
      ResumePoint.POSITION -> position
      ResumePoint.REWOUND -> maxOf(runStart, position - CloudVoice.SAMPLE_RATE * 2L)
      ResumePoint.BLOCK_START -> marks.lastOrNull { it.first <= position }?.first ?: 0
    }
    paused = true
    epoch += 1
    onState(SpeechState(publishedBlock, true))
    changed.signalAll()
  }

  private fun resumeLocked() {
    if (cancelled || ended || !paused) return
    Log.i(TAG, "resume")
    // A permanent loss gives focus to another app; take it back, or stay paused during a call.
    if (AudioManagerCompat.requestAudioFocus(audioManager, focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
      Log.i(TAG, "audio focus refused, staying paused")
      return
    }
    paused = false
    interrupted = false
    seekLocked(resumeFrame)
    publishBlock(resumeFrame, force = true)
  }

  private fun openAudio() {
    lock.withLock { cache = RandomAccessFile(cacheFile, "rw") }
    if (AudioManagerCompat.requestAudioFocus(audioManager, focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
      throw SpeechException("Another app is using audio.")
    }
    ContextCompat.registerReceiver(
      context,
      noisy,
      IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
      ContextCompat.RECEIVER_NOT_EXPORTED,
    )
  }

  private fun play() {
    val track = try {
      buildTrack()
    } catch (error: Exception) {
      lock.withLock { fail(error) }
      return
    }
    var trackPace = 1f
    try {
      lock.withLock { this.track = track }
      while (true) {
        var chunk = ByteArray(0)
        var chunkEpoch = 0
        var silence = false
        lock.withLock {
          while (true) {
            if (cancelled || ended) return
            if (trackEpoch != epoch) {
              track.pause()
              track.flush()
              trackStart = playFrame - track.playbackHeadPosition.toUInt().toLong()
              trackEpoch = epoch
              padded = false
              if (!paused) track.play()
            }
            if (trackPace != pace) {
              track.playbackParams = track.playbackParams.setSpeed(pace).setPitch(1f)
              trackPace = pace
            }
            if (paused) {
              changed.await()
              continue
            }
            val position = position()
            publishBlock(position)
            changed.signalAll()
            if (playFrame < writtenFrames) {
              if (starvedAt != null) {
                Log.i(TAG, "playback resumed after ${SystemClock.elapsedRealtime() - starvedAt!!}ms without audio")
                starvedAt = null
              }
              chunk = ByteArray(minOf(CHUNK_FRAMES, writtenFrames - playFrame).toInt() * 2)
              cache!!.seek(playFrame * 2)
              cache!!.readFully(chunk)
              chunkEpoch = epoch
              break
            }
            if (generationIdle) {
              if (position >= writtenFrames) {
                ended = true
                changed.signalAll()
                return
              }
              // A streaming track holds back audio shorter than its buffer; silence pushes the tail out.
              if (!padded) {
                padded = true
                chunk = ByteArray(track.bufferSizeInFrames * 2)
                chunkEpoch = epoch
                silence = true
                break
              }
            } else if (starvedAt == null && position >= writtenFrames) {
              starvedAt = SystemClock.elapsedRealtime()
              val waiting = if (nextIndex >= blocks.size) "waiting for text" else "generating block ${nextIndex - 1}"
              Log.i(TAG, "ran out of audio at %.1fs, $waiting".format(position.toDouble() / CloudVoice.SAMPLE_RATE))
            }
            changed.await(TICK_MILLIS, TimeUnit.MILLISECONDS)
          }
        }
        val written = track.write(chunk, 0, chunk.size, AudioTrack.WRITE_BLOCKING)
        if (written < 0) throw SpeechException("Could not play speech audio (error $written).")
        lock.withLock { if (chunkEpoch == epoch && !silence) playFrame += written / 2 }
      }
    } catch (error: Exception) {
      lock.withLock { fail(error) }
    } finally {
      lock.withLock { this.track = null }
      track.release()
    }
  }

  private var padded = false

  /** The buffer must cover the fastest pace, or setting it fails. */
  private fun buildTrack(): AudioTrack {
    val minimum = AudioTrack.getMinBufferSize(
      CloudVoice.SAMPLE_RATE,
      AudioFormat.CHANNEL_OUT_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
    )
    if (minimum <= 0) throw SpeechException("This device cannot play speech audio (error $minimum).")
    return AudioTrack.Builder()
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build(),
      )
      .setAudioFormat(
        AudioFormat.Builder()
          .setSampleRate(CloudVoice.SAMPLE_RATE)
          .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
          .build(),
      )
      .setTransferMode(AudioTrack.MODE_STREAM)
      .setBufferSizeInBytes(maxOf(minimum * MAX_PACE, CloudVoice.SAMPLE_RATE / 5 * 2))
      .build()
  }

  private fun seekLocked(target: Long) {
    starvedAt = null
    playFrame = minOf(target, writtenFrames)
    epoch += 1
    changed.signalAll()
  }

  /** The cached frame playing now. A track's head position counts source frames at any pace. */
  private fun position(): Long {
    val track = track
    return when {
      paused -> resumeFrame
      track == null || trackEpoch != epoch -> playFrame
      else -> minOf(playFrame, trackStart + track.playbackHeadPosition.toUInt().toLong())
    }
  }

  private fun currentBlock(): Int? {
    val position = position()
    return marks.lastOrNull { it.first <= position }?.second
  }

  private fun publishBlock(frame: Long, force: Boolean = false) {
    val block = marks.lastOrNull { it.first <= frame }?.second
    if (!force && block == publishedBlock) return
    publishedBlock = block
    onState(SpeechState(block, paused))
  }

  private fun fail(error: Exception) {
    Log.e(TAG, "failed: ${error.message}", error)
    if (failure == null) failure = error
    cancelLocked()
  }

  private fun cancelLocked() {
    cancelled = true
    voice.cancel()
    changed.signalAll()
  }

  fun cancel() = lock.withLock { cancelLocked() }

  private fun close() {
    lock.withLock {
      cancelled = true
      cache?.close()
      cacheFile.delete()
    }
    runCatching { context.unregisterReceiver(noisy) }
    AudioManagerCompat.abandonAudioFocusRequest(audioManager, focus)
  }

  companion object {
    private const val LOOKAHEAD_FRAMES = CloudVoice.SAMPLE_RATE * 15L
    private const val CHUNK_FRAMES = CloudVoice.SAMPLE_RATE / 10L
    private const val TICK_MILLIS = 100L
    private const val MAX_PACE = 2
  }
}

internal fun speechSegments(text: String, maxLength: Int): List<String> {
  val segments = mutableListOf<String>()
  val pending = StringBuilder()
  fun add(part: String) {
    if (pending.isNotEmpty() && pending.length + 1 + part.length > maxLength) {
      segments.add(pending.toString())
      pending.clear()
    }
    if (pending.isNotEmpty()) pending.append(' ')
    pending.append(part)
  }
  val sentences = BreakIterator.getSentenceInstance(Locale.ROOT).apply { setText(text) }
  var start = sentences.first()
  var end = sentences.next()
  while (end != BreakIterator.DONE) {
    val sentence = text.substring(start, end).trim()
    if (sentence.length <= maxLength) {
      if (sentence.isNotEmpty()) add(sentence)
    } else {
      for (word in sentence.split(Regex("\\s+"))) word.chunked(maxLength).forEach(::add)
    }
    start = end
    end = sentences.next()
  }
  if (pending.isNotEmpty()) segments.add(pending.toString())
  return segments
}
