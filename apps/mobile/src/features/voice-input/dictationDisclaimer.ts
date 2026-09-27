/** Speech recognition mishears words, so dictated messages say so to the agent. */
const DICTATION_DISCLAIMER = "\n\n(voice transcription, may contain errors)";
/** A reply that will be read aloud should be written for listening. */
const READ_ALOUD_DISCLAIMER =
  '\n\n(voice transcription, may contain errors. Your reply will be read aloud: keep it brief, skip code, and write it as it would be spoken, e.g. "100 to 200 dollars per month", not "$100-200/mo".)';

/** Marks a draft as dictated, keeping exactly one disclaimer at its end. */
export function withDictationDisclaimer(text: string, readAloud: boolean): string {
  const bare = text.split(DICTATION_DISCLAIMER).join("").split(READ_ALOUD_DISCLAIMER).join("");
  return bare + (readAloud ? READ_ALOUD_DISCLAIMER : DICTATION_DISCLAIMER);
}
