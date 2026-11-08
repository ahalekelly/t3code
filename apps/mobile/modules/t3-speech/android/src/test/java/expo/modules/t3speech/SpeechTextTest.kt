package expo.modules.t3speech

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Instant

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], manifest = Config.NONE)
class SpeechTextTest {
  @Test
  fun segmentsJoinSentencesUpToTheLimit() {
    assertEquals(
      listOf("One. Two.", "Three is longer."),
      speechSegments("One. Two. Three is longer.", 16),
    )
  }

  @Test
  fun segmentsSplitSentencesAndWordsLongerThanTheLimit() {
    assertEquals(listOf("aaaaaa", "aaaa", "bb cc"), speechSegments("aaaaaaaaaa bb cc", 6))
  }

  @Test
  fun quotaRefillsAfterRetryAfterSeconds() {
    val now = Instant.parse("2026-11-15T10:00:00Z").toEpochMilli()
    assertEquals(now + 90_000, CloudVoice.quotaRefill("90", now))
  }

  @Test
  fun quotaRefillsOnTheNextSecondOfTheMonth() {
    fun refill(now: String) = Instant.ofEpochMilli(CloudVoice.quotaRefill(null, Instant.parse(now).toEpochMilli())).toString()
    assertEquals("2026-11-02T00:00:00Z", refill("2026-11-01T23:00:00Z"))
    assertEquals("2026-12-02T00:00:00Z", refill("2026-11-02T00:00:00Z"))
    assertEquals("2027-01-02T00:00:00Z", refill("2026-12-31T10:00:00Z"))
  }
}
