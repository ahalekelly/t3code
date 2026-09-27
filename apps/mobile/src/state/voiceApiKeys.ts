import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { MobileSecureStorage } from "../persistence/mobile-secure-storage";
import type { VoiceApiProvider } from "../lib/speechSettings";
import * as Runtime from "../lib/runtime";

const voiceApiKeysRuntime = Atom.runtime(Runtime.runtimeContextLayer);

const storageKey = (provider: VoiceApiProvider) => `t3code.voice.${provider}-api-key`;

const storedApiKeyAtom = Atom.family((provider: VoiceApiProvider) =>
  voiceApiKeysRuntime
    .atom(
      MobileSecureStorage.pipe(Effect.flatMap((storage) => storage.getItem(storageKey(provider)))),
    )
    .pipe(Atom.keepAlive, Atom.withLabel(`mobile:voice:${provider}-api-key:stored`)),
);

// A completed write outranks the keychain read for the rest of the session, so
// readers see the new key without waiting for another read.
const writtenApiKeyAtom = Atom.family((provider: VoiceApiProvider) =>
  Atom.make(Option.none<string | null>()).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:voice:${provider}-api-key:written`),
  ),
);

/** The provider's stored API key, or `null` when none is saved. */
export const voiceApiKeyAtom = Atom.family((provider: VoiceApiProvider) =>
  Atom.make((get) => {
    const written = get(writtenApiKeyAtom(provider));
    return Option.isSome(written)
      ? AsyncResult.success(written.value)
      : get(storedApiKeyAtom(provider));
  }).pipe(Atom.keepAlive, Atom.withLabel(`mobile:voice:${provider}-api-key`)),
);

/** Stores a trimmed key, or clears it when the value is empty. */
export const setVoiceApiKeyAtom = Atom.family((provider: VoiceApiProvider) =>
  voiceApiKeysRuntime
    .fn((value: string, get) => {
      const key = value.trim();
      return MobileSecureStorage.pipe(
        Effect.flatMap((storage) =>
          key === ""
            ? storage.removeItem(storageKey(provider))
            : storage.setItem(storageKey(provider), key),
        ),
        Effect.tap(() =>
          Effect.sync(() =>
            get.set(writtenApiKeyAtom(provider), Option.some(key === "" ? null : key)),
          ),
        ),
      );
    })
    .pipe(Atom.keepAlive, Atom.withLabel(`mobile:voice:${provider}-api-key:set`)),
);
