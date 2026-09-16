export const SPEECH_MODELS = {
  pocket: {
    label: "Pocket TTS",
    download: "236 MB",
    attribution: "Pocket TTS by Kyutai. Voice license: creativecommons.org/licenses/by/4.0",
  },
  supertonic: {
    label: "Supertonic 3",
    download: "170 MB",
    attribution: "Supertonic 3 by Supertone. Model license: OpenRAIL-M.",
  },
} as const;

export type SpeechModel = keyof typeof SPEECH_MODELS;
export const DEFAULT_SPEECH_MODEL: SpeechModel = "pocket";
