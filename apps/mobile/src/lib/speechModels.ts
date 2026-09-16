export const SPEECH_MODELS = {
  pocket: {
    label: "Pocket TTS",
    voices: ["Alba", "Marius", "Javert", "Jean", "Fantine", "Cosette", "Eponine", "Azelma"],
    download: "240 MB",
    attribution: "Pocket TTS by Kyutai. Voice license: creativecommons.org/licenses/by/4.0",
  },
  supertonic: {
    label: "Supertonic 3",
    voices: ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"],
    download: "170 MB",
    attribution: "Supertonic 3 by Supertone. Model license: OpenRAIL-M.",
  },
} as const;

export type SpeechModel = keyof typeof SPEECH_MODELS;
export const DEFAULT_SPEECH_MODEL: SpeechModel = "pocket";

export const SPEECH_QUALITIES = { fast: "Fast", balanced: "Balanced", high: "High" } as const;
export type SpeechQuality = keyof typeof SPEECH_QUALITIES;
export type SpeechSettings = {
  readonly voice: string;
  readonly pace: number;
  readonly quality: SpeechQuality;
};
export type SpeechOptions = SpeechSettings & { readonly model: SpeechModel };
export type SpeechPreferences = {
  readonly responseSpeechModel?: SpeechModel;
  readonly responseSpeechSettings?: Partial<Record<SpeechModel, SpeechSettings>>;
};
export const SPEECH_PACES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export function getSpeechOptions(preferences: SpeechPreferences): SpeechOptions {
  const model = preferences.responseSpeechModel ?? DEFAULT_SPEECH_MODEL;
  return {
    model,
    ...(preferences.responseSpeechSettings?.[model] ?? {
      voice: SPEECH_MODELS[model].voices[0],
      pace: 1,
      quality: "balanced",
    }),
  };
}

export function validateSpeechSettings(model: SpeechModel, value: unknown): SpeechSettings {
  if (
    typeof value !== "object" ||
    value === null ||
    !("voice" in value) ||
    !("pace" in value) ||
    !("quality" in value) ||
    typeof value.voice !== "string" ||
    !(SPEECH_MODELS[model].voices as readonly string[]).includes(value.voice) ||
    typeof value.pace !== "number" ||
    !Number.isFinite(value.pace) ||
    value.pace < 0.75 ||
    value.pace > 2 ||
    typeof value.quality !== "string" ||
    !Object.hasOwn(SPEECH_QUALITIES, value.quality)
  ) {
    throw new Error(`Invalid voice settings for ${SPEECH_MODELS[model].label}.`);
  }
  return { voice: value.voice, pace: value.pace, quality: value.quality as SpeechQuality };
}
