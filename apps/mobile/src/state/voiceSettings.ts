import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { resolveVoiceTranscriptionSource } from "../lib/voiceTranscriptionSources";
import {
  DEFAULT_SPEECH_INSTRUCTIONS,
  DEFAULT_SPEECH_MODEL,
  SPEECH_MODELS,
  type SpeechRequest,
} from "../lib/speechSettings";
import { mobilePreferencesAtom } from "./preferences";
import { voiceApiKeyAtom } from "./voiceApiKeys";

/** Voice input and read-aloud settings; transcription defaults follow the stored OpenAI key. */
export function useVoiceSettings() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const openAiKeyResult = useAtomValue(voiceApiKeyAtom("openai"));
  const geminiKeyResult = useAtomValue(voiceApiKeyAtom("gemini"));
  return useMemo(() => {
    const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : {};
    const apiKeys = {
      openai: AsyncResult.isSuccess(openAiKeyResult) ? openAiKeyResult.value : null,
      gemini: AsyncResult.isSuccess(geminiKeyResult) ? geminiKeyResult.value : null,
    };
    const model = preferences.responseSpeechModel ?? DEFAULT_SPEECH_MODEL;
    const { provider, voices } = SPEECH_MODELS[model];
    const voice = preferences.responseSpeechVoice;
    const speech: SpeechRequest = {
      model,
      // A voice saved for another model falls back to this model's default.
      voice: voice && (voices as readonly string[]).includes(voice) ? voice : voices[0],
      pace: preferences.responseSpeechPace ?? 1,
      instructions: preferences.responseSpeechInstructions ?? DEFAULT_SPEECH_INSTRUCTIONS,
      apiKey: apiKeys[provider] ?? "",
    };
    return {
      loaded:
        AsyncResult.isSuccess(preferencesResult) &&
        AsyncResult.isSuccess(openAiKeyResult) &&
        AsyncResult.isSuccess(geminiKeyResult),
      preferences,
      apiKey: apiKeys.openai,
      speech,
      transcriptionSource: resolveVoiceTranscriptionSource(
        preferences.voiceTranscriptionSource,
        apiKeys.openai !== null,
      ),
      readRepliesAloud: preferences.readVoiceRepliesAloud ?? true,
      readThinkingUpdates: preferences.readThinkingUpdatesAloud ?? false,
    };
  }, [geminiKeyResult, openAiKeyResult, preferencesResult]);
}
