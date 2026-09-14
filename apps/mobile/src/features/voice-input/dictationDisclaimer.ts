/** Speech recognition mishears words, so dictated messages say so to the agent. */
const DICTATION_DISCLAIMER = "\n\n(voice transcription, may contain errors)";

/** Marks a draft as dictated, keeping exactly one disclaimer at its end. */
export function withDictationDisclaimer(text: string): string {
  return text.split(DICTATION_DISCLAIMER).join("") + DICTATION_DISCLAIMER;
}
