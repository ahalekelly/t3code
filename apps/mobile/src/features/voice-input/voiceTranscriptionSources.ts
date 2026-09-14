/**
 * Selectable transcription sources, in menu order: the device, then the OpenAI
 * models keyed by the id their API expects. Kept free of native imports so
 * persistence can validate the stored choice without pulling in a transcriber.
 */
export const VOICE_TRANSCRIPTION_SOURCE_LABELS = {
  local: "On this device",
  "gpt-transcribe": "GPT Transcribe",
  "gpt-4o-transcribe": "GPT-4o Transcribe",
  "gpt-4o-mini-transcribe": "GPT-4o Mini Transcribe",
  "whisper-1": "Whisper",
} as const;

export type VoiceTranscriptionSource = keyof typeof VOICE_TRANSCRIPTION_SOURCE_LABELS;

export type OpenAiTranscriptionModelId = Exclude<VoiceTranscriptionSource, "local">;

export const DEFAULT_VOICE_TRANSCRIPTION_SOURCE: VoiceTranscriptionSource = "local";
