export const VOICE_API_PROVIDERS = {
  openai: { label: "OpenAI" },
  gemini: { label: "Gemini" },
  elevenlabs: { label: "ElevenLabs" },
  azure: { label: "Azure Speech" },
} as const;
export type VoiceApiProvider = keyof typeof VOICE_API_PROVIDERS;

/**
 * Stored API keys, in field order. Azure keys come from Speech resources in West US 2,
 * where MAI voices and transcription run.
 */
export const VOICE_API_KEYS = {
  openai: { provider: "openai", label: "OpenAI", placeholder: "sk-..." },
  gemini: { provider: "gemini", label: "Gemini", placeholder: "AIza..." },
  elevenlabs: { provider: "elevenlabs", label: "ElevenLabs", placeholder: "sk_..." },
  azureFree: { provider: "azure", label: "Azure Speech free (F0)", placeholder: "West US 2 F0 key" },
  azure: { provider: "azure", label: "Azure Speech (S0)", placeholder: "West US 2 S0 key" },
} as const satisfies Record<string, { provider: VoiceApiProvider; label: string; placeholder: string }>;
export type VoiceApiKey = keyof typeof VOICE_API_KEYS;

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

// US English MAI voices; native reading adds the en-US prefix.
const MAI_VOICES = ["Harper", "Olivia", "Iris", "Ethan", "Grant", "Jasper", "Sage"] as const;

/**
 * Read-aloud models; each lists its voices with the default first, or reads the
 * voices saved in the ElevenLabs account. `instructions` marks models that take a
 * free-form delivery prompt.
 */
export const SPEECH_MODELS = {
  "gpt-4o-mini-tts": {
    label: "OpenAI",
    provider: "openai",
    centsPerMinute: 1.5,
    instructions: true,
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
    instructions: true,
    voices: GEMINI_VOICES,
  },
  "gemini-3.8-flash-lite-tts": {
    label: "Gemini Flash-Lite",
    provider: "gemini",
    centsPerMinute: 0.9,
    instructions: true,
    voices: GEMINI_VOICES,
  },
  eleven_v4: {
    label: "ElevenLabs v4",
    provider: "elevenlabs",
    centsPerMinute: 7,
    instructions: false,
    voices: "account",
  },
  eleven_v4_turbo: {
    label: "ElevenLabs v4 Turbo",
    provider: "elevenlabs",
    centsPerMinute: 3.5,
    instructions: false,
    voices: "account",
  },
  "MAI-Voice-2.1": {
    label: "MAI-Voice-2.1",
    provider: "azure",
    centsPerMinute: 2,
    instructions: false,
    voices: MAI_VOICES,
  },
  "MAI-Voice-2.1-Flash": {
    label: "MAI-Voice-2.1 Flash",
    provider: "azure",
    centsPerMinute: 1.35,
    instructions: false,
    voices: MAI_VOICES,
  },
} as const satisfies Record<
  string,
  {
    label: string;
    provider: VoiceApiProvider;
    centsPerMinute: number;
    instructions: boolean;
    voices: readonly [string, ...string[]] | "account";
  }
>;
export type SpeechModel = keyof typeof SPEECH_MODELS;
export const DEFAULT_SPEECH_MODEL: SpeechModel = "MAI-Voice-2.1-Flash";

export const SPEECH_PACES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;
export type SpeechPace = (typeof SPEECH_PACES)[number];

export const DEFAULT_SPEECH_INSTRUCTIONS = "Read at a brisk, clear pace.";

/** A voice the model can read with; `id` is what the provider's API takes. */
export type SpeechVoice = { readonly id: string; readonly name: string };

/** What native reading needs to read a response aloud. */
export type SpeechRequest = {
  readonly provider: VoiceApiProvider;
  readonly model: SpeechModel;
  readonly voice: string;
  readonly pace: SpeechPace;
  readonly instructions: string;
  /**
   * The provider's stored keys in field order. A 403 moves on to the next key, so
   * Azure's free key serves until its monthly quota runs out.
   */
  readonly apiKeys: readonly string[];
};
