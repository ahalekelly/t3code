package expo.modules.t3speech

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import androidx.media.AudioAttributesCompat
import androidx.media.AudioFocusRequestCompat
import androidx.media.AudioManagerCompat
import kotlin.math.PI
import kotlin.math.min
import kotlin.math.sin

enum class SpeechCue(vararg val notes: Double) {
  SENT(880.0, 1_320.0),
  ATTENTION(660.0, 880.0, 660.0),
  ERROR(440.0, 294.0);

  val durationMillis get() = notes.size * NOTE_MILLIS

  companion object {
    const val NOTE_MILLIS = 110L

    fun parse(cue: String) = entries.firstOrNull { it.name.lowercase() == cue } ?: throw SpeechException("Unknown cue: $cue")
  }
}

/** Cues need no network, so they still work when the speech provider cannot be reached. Main thread only. */
internal object SpeechCues {
  private const val SAMPLE_RATE = 44_100
  private val main = Handler(Looper.getMainLooper())
  private val attributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_ASSISTANT)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .build()
  private val focus = AudioFocusRequestCompat.Builder(AudioManagerCompat.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
    .setAudioAttributes(AudioAttributesCompat.wrap(attributes)!!)
    .setOnAudioFocusChangeListener {}
    .build()
  private var player: AudioTrack? = null
  private var synthesizer: TextToSpeech? = null
  private var synthesizerReady = false
  private val waiting = mutableListOf<String>()
  private var speaking = 0
  private var utterances = 0

  fun play(context: Context, cue: SpeechCue) {
    AudioManagerCompat.requestAudioFocus(context.getSystemService(AudioManager::class.java), focus)
    player?.release()
    val samples = tones(cue.notes)
    val player = AudioTrack.Builder()
      .setAudioAttributes(attributes)
      .setAudioFormat(
        AudioFormat.Builder()
          .setSampleRate(SAMPLE_RATE)
          .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
          .build(),
      )
      .setTransferMode(AudioTrack.MODE_STATIC)
      .setBufferSizeInBytes(samples.size * 2)
      .build()
    player.write(samples, 0, samples.size)
    player.play()
    this.player = player
    main.postDelayed({
      player.release()
      if (this.player === player) this.player = null
      releaseFocusWhenIdle(context)
    }, cue.durationMillis + 100)
  }

  fun announce(context: Context, text: String, cue: SpeechCue) {
    play(context, cue)
    main.postDelayed({ speak(context, text) }, cue.durationMillis)
  }

  private fun speak(context: Context, text: String) {
    AudioManagerCompat.requestAudioFocus(context.getSystemService(AudioManager::class.java), focus)
    speaking += 1
    val synthesizer = synthesizer ?: TextToSpeech(context) { status ->
      main.post {
        if (status != TextToSpeech.SUCCESS) {
          Log.e(TAG, "text to speech failed to start ($status)")
          speaking -= waiting.size
          waiting.clear()
          this.synthesizer = null
          releaseFocusWhenIdle(context)
          return@post
        }
        synthesizerReady = true
        waiting.forEach(::utter)
        waiting.clear()
        releaseFocusWhenIdle(context)
      }
    }.also {
      it.setAudioAttributes(attributes)
      it.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String) {}
        override fun onDone(utteranceId: String) = finished(context)
        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String) = finished(context)
        override fun onError(utteranceId: String, errorCode: Int) = finished(context)
      })
      this.synthesizer = it
    }
    if (synthesizerReady) {
      utter(text)
      releaseFocusWhenIdle(context)
    } else {
      waiting.add(text)
    }
  }

  private fun utter(text: String) {
    if (synthesizer!!.speak(text, TextToSpeech.QUEUE_ADD, null, "t3-announcement-${++utterances}") == TextToSpeech.SUCCESS) return
    Log.e(TAG, "text to speech refused an announcement")
    speaking -= 1
  }

  private fun finished(context: Context) {
    main.post {
      speaking -= 1
      releaseFocusWhenIdle(context)
    }
  }

  private fun releaseFocusWhenIdle(context: Context) {
    if (player != null || speaking > 0) return
    AudioManagerCompat.abandonAudioFocusRequest(context.getSystemService(AudioManager::class.java), focus)
  }

  private fun tones(notes: DoubleArray): ShortArray {
    val noteFrames = (SAMPLE_RATE * SpeechCue.NOTE_MILLIS / 1_000).toInt()
    val samples = ShortArray(notes.size * noteFrames)
    for ((index, frequency) in notes.withIndex()) {
      for (frame in 0 until noteFrames) {
        val envelope = min(1.0, min(frame / 300.0, (noteFrames - frame) / 1_500.0))
        samples[index * noteFrames + frame] = (sin(2 * PI * frequency * frame / SAMPLE_RATE) * envelope * 9_000).toInt().toShort()
      }
    }
    return samples
  }
}
