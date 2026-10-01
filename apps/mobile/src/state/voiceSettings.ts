import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { resolveVoiceTranscriptionSource } from "../lib/voiceTranscriptionSources";
import {
  DEFAULT_SPEECH_INSTRUCTIONS,
  DEFAULT_SPEECH_MODEL,
  SPEECH_MODELS,
  type SpeechRequest,
  type SpeechVoice,
} from "../lib/speechSettings";
import { mobilePreferencesAtom } from "./preferences";
import { elevenLabsVoicesAtom, voiceApiKeyAtom } from "./voiceApiKeys";

const noAccountVoicesAtom = Atom.make(AsyncResult.success<SpeechVoice[]>([]));

/** Voice input and read-aloud settings; transcription defaults follow the stored OpenAI key. */
export function useVoiceSettings() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const preferences = useMemo(
    () => (AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : {}),
    [preferencesResult],
  );
  const model = preferences.responseSpeechModel ?? DEFAULT_SPEECH_MODEL;
  const { provider, voices: modelVoices } = SPEECH_MODELS[model];
  const openAiKeyResult = useAtomValue(voiceApiKeyAtom("openai"));
  const azureKeyResult = useAtomValue(voiceApiKeyAtom("azure"));
  const speechKeyResult = useAtomValue(voiceApiKeyAtom(provider));
  const speechKey = AsyncResult.isSuccess(speechKeyResult) ? speechKeyResult.value : null;
  const accountVoicesResult = useAtomValue(
    modelVoices === "account" && speechKey ? elevenLabsVoicesAtom(speechKey) : noAccountVoicesAtom,
  );
  return useMemo(() => {
    const openAiKey = AsyncResult.isSuccess(openAiKeyResult) ? openAiKeyResult.value : null;
    const transcriptionSource = resolveVoiceTranscriptionSource(
      preferences.voiceTranscriptionSource,
      openAiKey !== null,
    );
    const transcriptionKey =
      transcriptionSource === "openai"
        ? openAiKey
        : transcriptionSource === "azure" && AsyncResult.isSuccess(azureKeyResult)
          ? azureKeyResult.value
          : null;
    const voices: readonly SpeechVoice[] =
      modelVoices !== "account"
        ? modelVoices.map((id) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1) }))
        : AsyncResult.isSuccess(accountVoicesResult)
          ? accountVoicesResult.value
          : [];
    const voice = preferences.responseSpeechVoice;
    const speech: SpeechRequest = {
      provider,
      model,
      // A voice saved for another model falls back to this model's default.
      voice: voices.find(({ id }) => id === voice)?.id ?? voices[0]?.id ?? "",
      pace: preferences.responseSpeechPace ?? 1,
      instructions: preferences.responseSpeechInstructions ?? DEFAULT_SPEECH_INSTRUCTIONS,
      apiKey: speechKey ?? "",
    };
    return {
      loaded:
        AsyncResult.isSuccess(preferencesResult) &&
        AsyncResult.isSuccess(openAiKeyResult) &&
        AsyncResult.isSuccess(azureKeyResult) &&
        AsyncResult.isSuccess(speechKeyResult) &&
        !AsyncResult.isInitial(accountVoicesResult),
      preferences,
      transcriptionSource,
      /** The selected cloud source's key; null on device or without a stored key. */
      transcriptionKey,
      speech,
      voices,
      voicesError: AsyncResult.isFailure(accountVoicesResult)
        ? Option.getOrNull(Cause.findErrorOption(accountVoicesResult.cause))
        : null,
      readRepliesAloud: preferences.readVoiceRepliesAloud ?? true,
      readThinkingUpdates: preferences.readThinkingUpdatesAloud ?? false,
    };
  }, [
    accountVoicesResult,
    azureKeyResult,
    model,
    modelVoices,
    provider,
    openAiKeyResult,
    preferences,
    preferencesResult,
    speechKey,
    speechKeyResult,
  ]);
}
