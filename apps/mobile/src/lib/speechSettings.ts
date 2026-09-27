export type VoiceApiProvider = "openai" | "gemini";

// Gemini 3.8 TTS studio voices.
const GEMINI_VOICES = [
  "Kore",
  "Zephyr",
  "Puck",
  "Charon",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Algenib",
  "Rasalgethi",
  "Laomedeia",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Gacrux",
  "Pulcherrima",
  "Achird",
  "Zubenelgenubi",
  "Vindemiatrix",
  "Sadachbia",
  "Sadaltager",
  "Sulafat",
] as const;

/** Read-aloud models; each lists its voices with the default first. */
export const SPEECH_MODELS = {
  "gpt-4o-mini-tts": {
    label: "OpenAI",
    provider: "openai",
    centsPerMinute: 1.5,
    // Most natural first.
    voices: [
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
    ],
  },
  "gemini-3.8-flash-tts": {
    label: "Gemini Flash",
    provider: "gemini",
    centsPerMinute: 1.35,
    voices: GEMINI_VOICES,
  },
  "gemini-3.8-flash-lite-tts": {
    label: "Gemini Flash-Lite",
    provider: "gemini",
    centsPerMinute: 0.9,
    voices: GEMINI_VOICES,
  },
} as const satisfies Record<
  string,
  {
    label: string;
    provider: VoiceApiProvider;
    centsPerMinute: number;
    voices: readonly [string, ...string[]];
  }
>;
export type SpeechModel = keyof typeof SPEECH_MODELS;
export const DEFAULT_SPEECH_MODEL: SpeechModel = "gemini-3.8-flash-lite-tts";

export const SPEECH_PACES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;
export type SpeechPace = (typeof SPEECH_PACES)[number];

export const DEFAULT_SPEECH_INSTRUCTIONS = "Read at a brisk, clear pace.";

/** What native reading needs to read a response aloud. */
export type SpeechRequest = {
  readonly model: SpeechModel;
  readonly voice: string;
  readonly pace: SpeechPace;
  readonly instructions: string;
  readonly apiKey: string;
};
