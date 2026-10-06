import { memo } from "react";
import { Pressable, type ColorValue } from "react-native";

import { autoReadResponse } from "../lib/autoReadResponse";
import { responseSpeech, useSpokenBlock } from "../lib/responseSpeech";
import { useVoiceSettings } from "../state/voiceSettings";
import { SymbolView } from "./AppSymbol";

export const ReadResponseButton = memo(function ReadResponseButton(props: {
  readonly scope: string;
  readonly messageId: string;
  readonly title: string;
  readonly text: string;
  readonly canStart: boolean;
  readonly tintColor: ColorValue;
}) {
  const voice = useVoiceSettings();
  const speaking = useSpokenBlock(props.scope, props.messageId) !== undefined;

  if (!props.canStart && !speaking) return null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={speaking ? "Stop reading response" : "Read response aloud"}
      accessibilityState={{ selected: speaking }}
      hitSlop={4}
      className="size-10 items-center justify-center rounded-xl"
      style={({ pressed }) => ({ opacity: pressed ? 0.52 : 1 })}
      onPress={() => {
        autoReadResponse.cancel(props.scope);
        void responseSpeech.toggle(
          { scope: props.scope, messageId: props.messageId },
          props.text,
          voice.speech,
          props.title,
        );
      }}
    >
      <SymbolView
        name={speaking ? "stop.fill" : "speaker.wave.2"}
        size={20}
        tintColor={props.tintColor}
        type="monochrome"
      />
    </Pressable>
  );
});
