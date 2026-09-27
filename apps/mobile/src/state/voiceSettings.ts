import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { resolveVoiceTranscriptionSource } from "../lib/voiceTranscriptionSources";
import { DEFAULT_SPEECH_INSTRUCTIONS, type SpeechRequest } from "../lib/speechSettings";
import { mobilePreferencesAtom } from "./preferences";
import { openAiApiKeyAtom } from "./voiceTranscription";

/** Voice input and read-aloud settings; transcription defaults follow the stored OpenAI key. */
export function useVoiceSettings() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const apiKeyResult = useAtomValue(openAiApiKeyAtom);
  return useMemo(() => {
    const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : {};
    const apiKey = AsyncResult.isSuccess(apiKeyResult) ? apiKeyResult.value : null;
    const speech: SpeechRequest = {
      voice: preferences.responseSpeechVoice ?? "marin",
      pace: preferences.responseSpeechPace ?? 1,
      instructions: preferences.responseSpeechInstructions ?? DEFAULT_SPEECH_INSTRUCTIONS,
      apiKey: apiKey ?? "",
    };
    return {
      loaded: AsyncResult.isSuccess(preferencesResult) && AsyncResult.isSuccess(apiKeyResult),
      preferences,
      apiKey,
      speech,
      transcriptionSource: resolveVoiceTranscriptionSource(
        preferences.voiceTranscriptionSource,
        apiKey !== null,
      ),
      readRepliesAloud: preferences.readVoiceRepliesAloud ?? true,
      readThinkingUpdates: preferences.readThinkingUpdatesAloud ?? false,
    };
  }, [apiKeyResult, preferencesResult]);
}
