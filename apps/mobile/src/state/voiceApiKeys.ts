import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { MobileSecureStorage } from "../persistence/mobile-secure-storage";
import type { SpeechVoice, VoiceApiProvider } from "../lib/speechSettings";
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

/** The voices saved in the ElevenLabs account that owns `apiKey`; refetched once unused, so a failure can recover. */
export const elevenLabsVoicesAtom = Atom.family((apiKey: string) =>
  Atom.make(
    Effect.tryPromise({
      try: async () => {
        const voices: SpeechVoice[] = [];
        let pageToken: string | undefined;
        do {
          const url = new URL("https://api.elevenlabs.io/v2/voices?page_size=100");
          if (pageToken) url.searchParams.set("next_page_token", pageToken);
          const response = await fetch(url, { headers: { "xi-api-key": apiKey } });
          if (!response.ok) {
            throw new Error(
              `ElevenLabs voices failed (${response.status}): ${await response.text()}`,
            );
          }
          const page = (await response.json()) as {
            voices: { voice_id: string; name: string }[];
            has_more: boolean;
            next_page_token: string | null;
          };
          voices.push(...page.voices.map((voice) => ({ id: voice.voice_id, name: voice.name })));
          pageToken = page.has_more ? (page.next_page_token ?? undefined) : undefined;
        } while (pageToken);
        return voices;
      },
      catch: String,
    }),
  ).pipe(Atom.withLabel("mobile:voice:elevenlabs-voices")),
);
