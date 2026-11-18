package expo.modules.t3speech

import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.records.Required

class T3SpeechModule : Module() {
  private val context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("T3Speech")

    Events("onSpeechState")

    // Calls run in order on the module queue, so blocks appended right after `start` reach
    // the reading it created. Events carry the caller's `reading` id, so a late event from a
    // replaced reading can be told apart.
    AsyncFunction("start") { options: SpeechOptionsRecord, reading: String, promise: Promise ->
      SpeechPlayer.start(context, options::validated, { state ->
        sendEvent("onSpeechState", mapOf("reading" to reading, "block" to state.block, "paused" to state.paused))
      }) { result ->
        result.fold(
          { promise.resolve(it) },
          { promise.reject(it as? CodedException ?: CodedException(it.message ?: it.toString(), it)) },
        )
      }
    }

    AsyncFunction("append") { blocks: List<String>, from: Int -> SpeechPlayer.append(blocks, from) }
    AsyncFunction("finish") { SpeechPlayer.finish() }
    AsyncFunction("rewind") { SpeechPlayer.rewind() }
    AsyncFunction("nextBlock") { SpeechPlayer.nextBlock() }
    AsyncFunction("seekToBlock") { block: Int -> SpeechPlayer.seekToBlock(block) }
    AsyncFunction("pause") { SpeechPlayer.pause() }
    AsyncFunction("resume") { SpeechPlayer.resume() }

    AsyncFunction("setPace") { pace: Double ->
      SpeechPlayer.setPace(validPace(pace))
    }

    AsyncFunction("stop") { promise: Promise -> SpeechPlayer.stop { promise.resolve(null) } }

    AsyncFunction("playCue") { cue: String ->
      SpeechCues.play(context, SpeechCue.parse(cue))
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("announce") { text: String, cue: String ->
      SpeechCues.announce(context, text, SpeechCue.parse(cue))
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("beginBackgroundTask") { name: String ->
      BackgroundTasks.begin(context, name)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("endBackgroundTask") { task: Int ->
      BackgroundTasks.end(task)
    }.runOnQueue(Queues.MAIN)
  }
}

private fun validPace(pace: Double): Float {
  if (!pace.isFinite() || pace !in 0.75..2.0) throw SpeechException("Pace must be between 0.75× and 2×.")
  return pace.toFloat()
}

class SpeechOptionsRecord : Record {
  @Field @Required val provider: String = ""
  @Field @Required val model: String = ""
  @Field @Required val voice: String = ""
  @Field @Required val pace: Double = 1.0
  @Field @Required val instructions: String = ""
  @Field @Required val apiKeys: List<String> = emptyList()
  @Field @Required val title: String = ""

  internal fun validated(): SpeechSettings {
    val pace = validPace(pace)
    val provider = CloudVoice.Provider.entries.firstOrNull { it.id == provider }
      ?: throw SpeechException("Unknown speech provider: ${this.provider}")
    if (apiKeys.isEmpty()) throw SpeechException("Add your ${provider.label} API key in Settings → Voice.")
    if (voice.isEmpty()) throw SpeechException("Choose a voice for ${provider.label} in Settings → Voice.")
    return SpeechSettings(CloudVoice(provider, model, apiKeys, voice, instructions), pace, title)
  }
}

class SpeechException(message: String) : CodedException(message)
