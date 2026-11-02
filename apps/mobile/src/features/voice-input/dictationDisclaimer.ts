const DICTATION_DISCLAIMER = "\n\n(voice transcription, may contain errors)";
const READ_ALOUD_DISCLAIMER =
  '\n\n(voice transcription, may contain errors. Your reply will be read aloud word for word by a text-to-speech engine: keep it brief, skip code, and write it as it would be spoken, e.g. "12 degrees per second" not "12°/sec", "around 100 to 200 dollars per month" not "~$100-200/mo", "35 milliseconds" not "35ms", "150 watt hours" not "150 Wh".)';

export function withDictationDisclaimer(text: string, readAloud: boolean): string {
  const bare = text.split(DICTATION_DISCLAIMER).join("").split(READ_ALOUD_DISCLAIMER).join("");
  return bare + (readAloud ? READ_ALOUD_DISCLAIMER : DICTATION_DISCLAIMER);
}
