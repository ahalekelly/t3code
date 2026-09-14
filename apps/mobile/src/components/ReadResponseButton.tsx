import { memo, useSyncExternalStore } from "react";
import { Pressable, type ColorValue } from "react-native";

import { responseSpeech } from "../lib/responseSpeech";
import { SymbolView } from "./AppSymbol";

export const ReadResponseButton = memo(function ReadResponseButton(props: {
  readonly scope: string;
  readonly messageId: string;
  readonly text: string;
  readonly tintColor: ColorValue;
}) {
  const active = useSyncExternalStore(responseSpeech.subscribe, responseSpeech.getSnapshot);
  const speaking = active?.scope === props.scope && active.messageId === props.messageId;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={speaking ? "Stop reading response" : "Read response aloud"}
      accessibilityState={{ selected: speaking }}
      hitSlop={8}
      className="size-7 items-center justify-center rounded-lg"
      style={({ pressed }) => ({ opacity: pressed ? 0.52 : 1 })}
      onPress={() => {
        void responseSpeech.toggle({ scope: props.scope, messageId: props.messageId }, props.text);
      }}
    >
      <SymbolView
        name={speaking ? "stop.fill" : "speaker.wave.2"}
        size={13}
        tintColor={props.tintColor}
        type="monochrome"
      />
    </Pressable>
  );
});
