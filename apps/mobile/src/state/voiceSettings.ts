import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { resolveVoiceTranscriptionSource } from "../features/voice-input/voiceTranscriptionSources";
import {
  DEFAULT_SPEECH_INSTRUCTIONS,
  getSpeechOptions,
  type SpeechOptions,
} from "../lib/speechModels";
import { mobilePreferencesAtom } from "./preferences";
import { openAiApiKeyAtom } from "./voiceTranscription";

/** What native reading needs beyond the per-model settings. */
export type SpeechRequest = SpeechOptions & {
  readonly instructions: string;
  readonly apiKey: string;
};

/** Voice input and read-aloud settings, with defaults that follow the stored OpenAI key. */
export function useVoiceSettings() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const apiKeyResult = useAtomValue(openAiApiKeyAtom);
  return useMemo(() => {
    const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : {};
    const apiKey = AsyncResult.isSuccess(apiKeyResult) ? apiKeyResult.value : null;
    const speech: SpeechRequest = {
      ...getSpeechOptions(preferences, apiKey !== null),
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
