/** OpenAI `gpt-4o-mini-tts` voices, most natural first. */
export const SPEECH_VOICES = [
  "marin",
  "cedar",
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
] as const;
export type SpeechVoice = (typeof SPEECH_VOICES)[number];

export const SPEECH_PACES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;
export type SpeechPace = (typeof SPEECH_PACES)[number];

export const DEFAULT_SPEECH_INSTRUCTIONS = "Read at a brisk, clear pace.";

/** What native reading needs to read a response aloud. */
export type SpeechRequest = {
  readonly voice: SpeechVoice;
  readonly pace: SpeechPace;
  readonly instructions: string;
  readonly apiKey: string;
};
