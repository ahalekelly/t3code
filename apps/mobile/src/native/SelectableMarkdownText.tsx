import { type ReactNode, useEffect, useMemo, useRef } from "react";
import {
  type GestureResponderEvent,
  Platform,
  StyleSheet,
  View,
  type ViewInstance,
} from "react-native";
import type {
  MarkdownSpeechBlocks,
  SelectableMarkdownTextProps,
} from "./SelectableMarkdownText.types";

import { MobileEnrichedMarkdownText } from "./EnrichedMarkdownText";
import { markdownBlocks } from "../lib/markdownSpeechText";
import { themeColorWithAlpha } from "../lib/mobileTheme";
import { useUniwindTheme } from "../lib/useUniwindTheme";

export type {
  MarkdownFileContextMenu,
  MarkdownFileContextMenuAction,
  MarkdownImageRenderer,
  MarkdownImageRequest,
  MarkdownImageSourceResolver,
  MarkdownLinkCustomization,
  MarkdownSpeechBlocks,
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
} from "./SelectableMarkdownText.types";

export function SelectableMarkdownText(props: SelectableMarkdownTextProps) {
  const theme = useUniwindTheme();
  const selectionColor = themeColorWithAlpha(theme["--color-focus"], 0.32);
  const selectionHandleColor = theme["--color-focus"];
  const textStyle = useMemo(
    () =>
      Platform.OS === "android"
        ? { selectionColor, selectionHandleColor, ...props.textStyle }
        : props.textStyle,
    [props.textStyle, selectionColor, selectionHandleColor],
  );
  const { markdown, speech } = props;
  const reading = speech !== undefined;
  // Only while reading: one view per top-level block, cut by the same parse as the speech.
  const blocks = useMemo(
    () => (reading ? markdownBlocks(markdown).map((block) => block.markdown) : null),
    [markdown, reading],
  );
  if (!speech || !blocks) return <MobileEnrichedMarkdownText {...props} textStyle={textStyle} />;
  return (
    <View style={{ marginTop: props.marginTop, marginBottom: props.marginBottom }}>
      {blocks.map((block, index) => (
        <SpeechBlock key={index} index={index} speech={speech}>
          <MobileEnrichedMarkdownText
            {...props}
            markdown={block}
            textStyle={textStyle}
            marginTop={0}
            marginBottom={0}
            allowTrailingMargin={index < blocks.length - 1}
          />
        </SpeechBlock>
      ))}
    </View>
  );
}

/**
 * One top-level block while reading, highlighted while it is read. A tap reads from the
 * block. It watches raw touches instead of claiming them, so links, text selection, and
 * horizontal scrolling inside the block keep working.
 */
function SpeechBlock(props: {
  readonly index: number;
  readonly speech: MarkdownSpeechBlocks;
  readonly children: ReactNode;
}) {
  const ref = useRef<ViewInstance>(null);
  const touch = useRef<{ x: number; y: number; time: number } | null>(null);
  const active = props.speech.activeBlock === props.index;
  const { revealBlock } = props.speech;
  useEffect(() => {
    if (active && ref.current) revealBlock(ref.current);
  }, [active, revealBlock]);
  const onTouchEnd = (event: GestureResponderEvent) => {
    const start = touch.current;
    touch.current = null;
    const { pageX, pageY, timestamp } = event.nativeEvent;
    if (
      start &&
      timestamp - start.time < 300 &&
      Math.hypot(pageX - start.x, pageY - start.y) < 10
    ) {
      props.speech.onPressBlock(props.index);
    }
  };
  return (
    <View
      ref={ref}
      style={[styles.speechBlock, active && { backgroundColor: props.speech.highlightColor }]}
      onTouchStart={(event) => {
        const { pageX, pageY, timestamp, touches } = event.nativeEvent;
        touch.current = touches.length === 1 ? { x: pageX, y: pageY, time: timestamp } : null;
      }}
      onTouchEnd={onTouchEnd}
      onTouchCancel={() => {
        touch.current = null;
      }}
    >
      {props.children}
    </View>
  );
}

// The padding frames the highlight; equal negative margins cancel it so the text does not move.
const styles = StyleSheet.create({
  speechBlock: {
    borderRadius: 8,
    marginHorizontal: -6,
    marginVertical: -3,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
});
