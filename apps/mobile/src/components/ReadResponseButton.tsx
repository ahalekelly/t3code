import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { mobilePreferencesAtom } from "../state/preferences";
import { memo, useSyncExternalStore } from "react";
import { Pressable, type ColorValue } from "react-native";

import { autoReadResponse } from "../lib/autoReadResponse";
import { DEFAULT_SPEECH_MODEL } from "../lib/speechModels";
import { responseSpeech } from "../lib/responseSpeech";
import { SymbolView } from "./AppSymbol";

export const ReadResponseButton = memo(function ReadResponseButton(props: {
  readonly scope: string;
  readonly messageId: string;
  readonly text: string;
  readonly canStart: boolean;
  readonly tintColor: ColorValue;
}) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const rate = AsyncResult.isSuccess(preferences) ? (preferences.value.responseSpeechRate ?? 1) : 1;
  const active = useSyncExternalStore(responseSpeech.subscribe, responseSpeech.getSnapshot);
  const speaking = active?.scope === props.scope && active.messageId === props.messageId;

  if (!props.canStart && !speaking) return null;

  return (
    <>
      {speaking ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Rewind 10 seconds"
          hitSlop={8}
          className="size-7 items-center justify-center rounded-lg"
          style={({ pressed }) => ({ opacity: pressed ? 0.52 : 1 })}
          onPress={() => void responseSpeech.rewind()}
        >
          <SymbolView
            name="gobackward.10"
            size={17}
            tintColor={props.tintColor}
            type="monochrome"
          />
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={speaking ? "Stop reading response" : "Read response aloud"}
        accessibilityState={{ selected: speaking }}
        hitSlop={8}
        className="size-7 items-center justify-center rounded-lg"
        style={({ pressed }) => ({ opacity: pressed ? 0.52 : 1 })}
        onPress={() => {
          autoReadResponse.cancel(props.scope);
          void responseSpeech.toggle(
            { scope: props.scope, messageId: props.messageId },
            props.text,
            rate,
            AsyncResult.isSuccess(preferences)
              ? (preferences.value.responseSpeechModel ?? DEFAULT_SPEECH_MODEL)
              : DEFAULT_SPEECH_MODEL,
          );
        }}
      >
        <SymbolView
          name={speaking ? "stop.fill" : "speaker.wave.2"}
          size={13}
          tintColor={props.tintColor}
          type="monochrome"
        />
      </Pressable>
    </>
  );
});
