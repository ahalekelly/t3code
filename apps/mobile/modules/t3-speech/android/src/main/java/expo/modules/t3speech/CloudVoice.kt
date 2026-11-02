package expo.modules.t3speech

import android.net.Uri
import android.util.Base64
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.Calendar
import java.util.TimeZone
import java.util.concurrent.CancellationException
import java.util.concurrent.ConcurrentHashMap

/** Streams 16-bit mono PCM at [SAMPLE_RATE]. Each reading gets its own instance, which [cancel] ends for good. */
internal class CloudVoice(
  val provider: Provider,
  val model: String,
  private val apiKeys: List<String>,
  val voice: String,
  private val instructions: String,
) {
  /** Matches the providers of `SPEECH_MODELS` in speechSettings.ts. */
  enum class Provider(val id: String, val label: String) {
    GEMINI("gemini", "Gemini"),
    ELEVENLABS("elevenlabs", "ElevenLabs"),
    AZURE("azure", "Azure Speech"),
  }

  private val cancelLock = Object()
  private var cancelled = false
  private var connection: HttpURLConnection? = null

  fun cancel() = synchronized(cancelLock) {
    cancelled = true
    connection?.disconnect()
    cancelLock.notifyAll()
  }

  /**
   * A dropped connection retries the whole segment, so part of it may repeat. Stops early when
   * [append] returns false.
   */
  fun generate(text: String, append: (ByteArray) -> Boolean) {
    for ((attempt, delay) in (listOf(0L) + RETRY_DELAYS).withIndex()) {
      sleep(delay)
      try {
        stream(text, append)
        return
      } catch (error: IOException) {
        if (attempt == RETRY_DELAYS.size || synchronized(cancelLock) { cancelled }) throw error
        Log.w(TAG, "${provider.label} speech attempt ${attempt + 1} failed, retrying: ${error.message}")
      }
    }
  }

  private fun sleep(millis: Long): Unit = synchronized(cancelLock) {
    val deadline = System.currentTimeMillis() + millis
    while (!cancelled) {
      val remaining = deadline - System.currentTimeMillis()
      if (remaining <= 0) return
      cancelLock.wait(remaining)
    }
    throw CancellationException("Speech was stopped.")
  }

  private fun stream(text: String, append: (ByteArray) -> Boolean) {
    val connection = open(text)
    try {
      val status = connection.responseCode
      if (status !in 200..299) {
        val body = connection.errorStream?.use { it.readBytes().decodeToString() }.orEmpty()
        // Gemini sends `error.message`, ElevenLabs `detail.message`; Azure sends no body.
        val json = runCatching { JSONObject(body) }.getOrNull()
        val message = (json?.optJSONObject("error") ?: json?.optJSONObject("detail"))?.optString("message")
        throw SpeechException("${provider.label} speech failed ($status): ${message.orEmpty().ifEmpty { "no details" }}")
      }

      val pcm = ByteArrayOutputStream()
      fun send(): Boolean {
        val bytes = pcm.toByteArray()
        val whole = bytes.size and 1.inv()
        pcm.reset()
        pcm.write(bytes, whole, bytes.size - whole)
        return append(bytes.copyOf(whole))
      }
      val piece = SAMPLE_RATE / 4 * 2

      when (provider) {
        Provider.ELEVENLABS, Provider.AZURE -> {
          val buffer = ByteArray(8_192)
          connection.inputStream.use { input ->
            while (true) {
              val count = input.read(buffer)
              if (count < 0) break
              pcm.write(buffer, 0, count)
              if (pcm.size() >= piece && !send()) return
            }
          }
        }
        Provider.GEMINI -> {
          // Server-sent events carry base64 audio in `step.delta` events, and sometimes
          // the first chunk in `step.start`.
          var completed = false
          connection.inputStream.bufferedReader().use { reader ->
            while (true) {
              val line = reader.readLine() ?: break
              if (!line.startsWith("data: {")) continue
              val event = JSONObject(line.substring(6))
              val parts: List<JSONObject?> = when (event.optString("event_type")) {
                "error" -> {
                  val message = event.optJSONObject("error")?.optString("message").orEmpty()
                  throw SpeechException("Gemini speech failed: ${message.ifEmpty { "no details" }}")
                }
                "interaction.completed" -> {
                  val ended = event.optJSONObject("interaction")?.optString("status").orEmpty()
                  if (ended != "completed") throw SpeechException("Gemini speech ended as ${ended.ifEmpty { "unknown" }}.")
                  completed = true
                  continue
                }
                "step.start" -> event.optJSONObject("step")?.optJSONArray("content").objects()
                "step.delta" -> listOf(event.optJSONObject("delta"))
                else -> continue
              }
              for (part in parts) {
                if (part?.optString("type") != "audio") continue
                val audio = try {
                  Base64.decode(part.getString("data"), Base64.DEFAULT)
                } catch (_: Exception) {
                  throw SpeechException("Gemini sent unreadable audio.")
                }
                pcm.write(audio)
              }
              if (pcm.size() >= piece && !send()) return
            }
          }
          if (!completed) throw IOException("Gemini speech stream ended early.")
        }
      }
      send()
    } finally {
      connection.disconnect()
    }
  }

  private fun open(text: String): HttpURLConnection {
    val now = System.currentTimeMillis()
    val keys = apiKeys.filterIndexed { index, key -> index == apiKeys.lastIndex || (spentKeys[key] ?: 0) <= now }
    for ((position, apiKey) in keys.withIndex()) {
      val connection = request(text, apiKey)
      val status = connection.responseCode
      if (status !in setOf(403, 429) || position == keys.lastIndex) return connection
      Log.i(TAG, "${provider.label} key refused with $status, trying the next key")
      if (status == 403) spentKeys[apiKey] = quotaRefill(connection.getHeaderField("Retry-After"), now)
      connection.disconnect()
    }
    throw SpeechException("Add your ${provider.label} API key in Settings → Voice.")
  }

  private fun request(text: String, apiKey: String): HttpURLConnection {
    val url: String
    val headers: Map<String, String>
    val body: String
    when (provider) {
      Provider.GEMINI -> {
        url = "https://generativelanguage.googleapis.com/v1beta/interactions"
        headers = mapOf("x-goog-api-key" to apiKey, "Content-Type" to "application/json")
        val content = JSONObject().put("type", "text").put("text", text)
        if (instructions.isNotEmpty()) {
          content.put("annotations", JSONArray().put(JSONObject().put("type", "speech_metadata").put("style", instructions)))
        }
        body = JSONObject()
          .put("model", model)
          .put("input", JSONArray().put(JSONObject().put("type", "user_input").put("content", JSONArray().put(content))))
          .put("response_format", JSONObject().put("type", "audio").put("mime_type", "audio/l16").put("sample_rate", SAMPLE_RATE))
          .put("generation_config", JSONObject().put("speech_config", JSONArray().put(JSONObject().put("voice", voice))))
          .put("stream", true)
          .toString()
      }
      Provider.ELEVENLABS -> {
        url = "https://api.elevenlabs.io/v1/text-to-speech/${Uri.encode(voice)}/stream?output_format=pcm_24000"
        headers = mapOf("xi-api-key" to apiKey, "Content-Type" to "application/json")
        body = JSONObject().put("text", text).put("model_id", model).toString()
      }
      Provider.AZURE -> {
        // The key must come from a West US 2 resource, which serves MAI voices and MAI-Transcribe.
        url = "https://westus2.tts.speech.microsoft.com/cognitiveservices/v1"
        headers = mapOf(
          "Ocp-Apim-Subscription-Key" to apiKey,
          "Content-Type" to "application/ssml+xml",
          "X-Microsoft-OutputFormat" to "raw-24khz-16bit-mono-pcm",
          "User-Agent" to "T3Code",
        )
        // MAI reads square brackets as delivery tags: a bracket starting a sentence gets
        // a 400, and others can stall the stream. Braces drop words. Parentheses read as written.
        val escaped = text
          .map { if (it in "[{") '(' else if (it in "]}") ')' else it }
          .joinToString("")
          .replace("&", "&amp;")
          .replace("<", "&lt;")
          .replace(">", "&gt;")
        body = """<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">""" +
          """<voice name="en-US-$voice:$model">$escaped</voice></speak>"""
      }
    }
    val connection = URL(url).openConnection() as HttpURLConnection
    synchronized(cancelLock) {
      if (cancelled) throw CancellationException("Speech was stopped.")
      this.connection = connection
    }
    connection.requestMethod = "POST"
    connection.doOutput = true
    connection.connectTimeout = 30_000
    connection.readTimeout = 60_000
    for ((name, value) in headers) connection.setRequestProperty(name, value)
    connection.outputStream.use { it.write(body.toByteArray()) }
    return connection
  }

  companion object {
    const val SAMPLE_RATE = 24_000
    const val SEGMENT_LENGTH = 600
    private val RETRY_DELAYS = listOf(1_000L, 3_000L, 8_000L)

    /**
     * Keys whose quota ran out, skipped until it refills. Azure's free tier answers 403 once
     * its monthly quota is spent and 429 while over its rate limit.
     */
    private val spentKeys = ConcurrentHashMap<String, Long>()

    /**
     * Azure's 403 says when the quota refills in `Retry-After` seconds. Without it, wait for the
     * next 2nd at midnight UTC, a day past the month's start in any time zone, so an early
     * retry can't find the quota still spent and skip a whole month.
     */
    internal fun quotaRefill(retryAfter: String?, now: Long): Long {
      retryAfter?.toDoubleOrNull()?.let { return now + (it * 1_000).toLong() }
      val second = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply {
        timeInMillis = now
        set(Calendar.DAY_OF_MONTH, 2)
        set(Calendar.HOUR_OF_DAY, 0)
        set(Calendar.MINUTE, 0)
        set(Calendar.SECOND, 0)
        set(Calendar.MILLISECOND, 0)
      }
      if (second.timeInMillis <= now) second.add(Calendar.MONTH, 1)
      return second.timeInMillis
    }
  }
}

private fun JSONArray?.objects(): List<JSONObject?> =
  if (this == null) emptyList() else List(length()) { optJSONObject(it) }
