import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
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
import { elevenLabsVoicesAtom, providerApiKeysAtom } from "./voiceApiKeys";

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
  const openAiKeysResult = useAtomValue(providerApiKeysAtom("openai"));
  const azureKeysResult = useAtomValue(providerApiKeysAtom("azure"));
  const speechKeysResult = useAtomValue(providerApiKeysAtom(provider));
  const elevenLabsKey = AsyncResult.isSuccess(speechKeysResult) ? speechKeysResult.value[0] : null;
  const accountVoicesResult = useAtomValue(
    modelVoices === "account" && elevenLabsKey
      ? elevenLabsVoicesAtom(elevenLabsKey)
      : noAccountVoicesAtom,
  );
  return useMemo(() => {
    const openAiKeys = AsyncResult.isSuccess(openAiKeysResult) ? openAiKeysResult.value : [];
    const azureKeys = AsyncResult.isSuccess(azureKeysResult) ? azureKeysResult.value : [];
    const transcriptionSource = resolveVoiceTranscriptionSource(
      preferences.voiceTranscriptionSource,
      openAiKeys.length > 0,
    );
    const transcriptionKeys =
      transcriptionSource === "openai"
        ? openAiKeys
        : transcriptionSource === "azure"
          ? azureKeys
          : [];
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
      apiKeys: AsyncResult.isSuccess(speechKeysResult) ? speechKeysResult.value : [],
    };
    return {
      loaded:
        AsyncResult.isSuccess(preferencesResult) &&
        AsyncResult.isSuccess(openAiKeysResult) &&
        AsyncResult.isSuccess(azureKeysResult) &&
        AsyncResult.isSuccess(speechKeysResult) &&
        !AsyncResult.isInitial(accountVoicesResult),
      preferences,
      transcriptionSource,
      /** The selected cloud source's stored keys; empty on device. */
      transcriptionKeys,
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
    azureKeysResult,
    model,
    modelVoices,
    provider,
    openAiKeysResult,
    preferences,
    preferencesResult,
    speechKeysResult,
  ]);
}
