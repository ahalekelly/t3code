/** Speech recognition mishears words, so dictated messages say so to the agent. */
const DICTATION_DISCLAIMER = "\n\n(voice transcription, may contain errors)";
/** A reply that will be read aloud should be written for listening. */
const READ_ALOUD_DISCLAIMER =
  '\n\n(voice transcription, may contain errors. Your reply will be read aloud word for word by a text-to-speech engine: keep it brief, skip code, and write it as it would be spoken, e.g. "12 degrees per second" not "12°/sec", "around 100 to 200 dollars per month" not "~$100-200/mo", "35 milliseconds" not "35ms", "150 watt hours" not "150 Wh".)';

/** Marks a draft as dictated, keeping exactly one disclaimer at its end. */
export function withDictationDisclaimer(text: string, readAloud: boolean): string {
  const bare = text.split(DICTATION_DISCLAIMER).join("").split(READ_ALOUD_DISCLAIMER).join("");
  return bare + (readAloud ? READ_ALOUD_DISCLAIMER : DICTATION_DISCLAIMER);
}
