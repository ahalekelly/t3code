/**
 * Kept free of native imports so persistence can validate the stored choice without pulling in a
 * transcriber.
 */
export const VOICE_TRANSCRIPTION_SOURCE_LABELS = {
  local: "This device",
  openai: "OpenAI",
  azure: "Microsoft MAI",
} as const;

export type VoiceTranscriptionSource = keyof typeof VOICE_TRANSCRIPTION_SOURCE_LABELS;
export type CloudTranscriptionSource = Exclude<VoiceTranscriptionSource, "local">;
export const CLOUD_TRANSCRIPTION_SOURCES: readonly CloudTranscriptionSource[] = ["openai", "azure"];

export function resolveVoiceTranscriptionSource(
  preference: VoiceTranscriptionSource | undefined,
  hasOpenAiApiKey: boolean,
): VoiceTranscriptionSource {
  return preference ?? (hasOpenAiApiKey ? "openai" : "local");
}
