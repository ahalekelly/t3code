/**
 * Selectable transcription sources, in menu order. Cloud sources are named after
 * the voice API provider whose key they use. Kept free of native imports so
 * persistence can validate the stored choice without pulling in a transcriber.
 */
export const VOICE_TRANSCRIPTION_SOURCE_LABELS = {
  local: "On this device",
  openai: "OpenAI",
  azure: "Microsoft MAI",
} as const;

export type VoiceTranscriptionSource = keyof typeof VOICE_TRANSCRIPTION_SOURCE_LABELS;
export type CloudTranscriptionSource = Exclude<VoiceTranscriptionSource, "local">;

/** Without a stored choice, OpenAI transcribes when a key is stored and the device otherwise. */
export function resolveVoiceTranscriptionSource(
  preference: VoiceTranscriptionSource | undefined,
  hasOpenAiApiKey: boolean,
): VoiceTranscriptionSource {
  return preference ?? (hasOpenAiApiKey ? "openai" : "local");
}
