import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { MobileSecureStorage } from "../persistence/mobile-secure-storage";
import * as Runtime from "../lib/runtime";

const OPENAI_API_KEY_STORAGE_KEY = "t3code.voice.openai-api-key";

const voiceTranscriptionRuntime = Atom.runtime(Runtime.runtimeContextLayer);

const storedOpenAiApiKeyAtom = voiceTranscriptionRuntime
  .atom(
    MobileSecureStorage.pipe(
      Effect.flatMap((storage) => storage.getItem(OPENAI_API_KEY_STORAGE_KEY)),
    ),
  )
  .pipe(Atom.keepAlive, Atom.withLabel("mobile:voice:openai-api-key:stored"));

// A completed write outranks the keychain read for the rest of the session, so
// readers see the new key without waiting for another read.
const writtenOpenAiApiKeyAtom = Atom.make(Option.none<string | null>()).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:voice:openai-api-key:written"),
);

/** The stored OpenAI key, or `null` when voice input transcribes on this device. */
export const openAiApiKeyAtom = Atom.make((get) => {
  const written = get(writtenOpenAiApiKeyAtom);
  return Option.isSome(written) ? AsyncResult.success(written.value) : get(storedOpenAiApiKeyAtom);
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:voice:openai-api-key"));

/** Stores a trimmed key, or clears it when the value is empty. */
export const setOpenAiApiKeyAtom = voiceTranscriptionRuntime
  .fn((value: string, get) => {
    const key = value.trim();
    return MobileSecureStorage.pipe(
      Effect.flatMap((storage) =>
        key === ""
          ? storage.removeItem(OPENAI_API_KEY_STORAGE_KEY)
          : storage.setItem(OPENAI_API_KEY_STORAGE_KEY, key),
      ),
      Effect.tap(() =>
        Effect.sync(() => get.set(writtenOpenAiApiKeyAtom, Option.some(key === "" ? null : key))),
      ),
    );
  })
  .pipe(Atom.keepAlive, Atom.withLabel("mobile:voice:openai-api-key:set"));
