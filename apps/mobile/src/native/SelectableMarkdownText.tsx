import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  type GestureResponderEvent,
  Platform,
  StyleSheet,
  View,
  type ViewInstance,
} from "react-native";
import { useGT } from "gt-react-native";
import type { AssistantCitation } from "@t3tools/contracts";
import { parseAssistantCitationHref } from "@t3tools/shared/assistantCitations";
import { AssistantCitationSheet } from "../components/AssistantCitationSheet";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";
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
  const [citation, setCitation] = useState<AssistantCitation | null>(null);
  const gt = useGT();
  const hasCitations = props.markdown.includes("t3-citation:");
  const theme = useUniwindTheme();
  const selectionColor = themeColorWithAlpha(theme["--color-focus"], 0.32);
  const selectionHandleColor = theme["--color-focus"];
  const textStyle =
    Platform.OS === "android"
      ? { selectionColor, selectionHandleColor, ...props.textStyle }
      : props.textStyle;
  const markdownProps: SelectableMarkdownTextProps = {
    ...props,
    textStyle,
    onLinkPress: hasCitations
      ? (href) => {
          const quote = parseAssistantCitationHref(href);
          if (quote) setCitation(quote);
          else props.onLinkPress?.(href);
        }
      : props.onLinkPress,
    fileContextMenu: hasCitations
      ? (href) =>
          parseAssistantCitationHref(href)
            ? {
                title: gt("Assistant quote"),
                actions: [
                  { id: "open-quote", title: gt("Open quote") },
                  { id: "copy-quote", title: gt("Copy quote") },
                ],
              }
            : props.fileContextMenu?.(href)
      : props.fileContextMenu,
    onFileContextMenuAction: hasCitations
      ? (href, actionId) => {
          const quote = parseAssistantCitationHref(href);
          if (quote) {
            if (actionId === "open-quote") setCitation(quote);
            else if (actionId === "copy-quote") copyTextWithHaptic(quote.text);
          } else props.onFileContextMenuAction?.(href, actionId);
        }
      : props.onFileContextMenuAction,
  };
  const { markdown, speech } = props;
  const reading = speech !== undefined;
  const blocks = useMemo(
    () => (reading ? markdownBlocks(markdown).map((block) => block.markdown) : null),
    [markdown, reading],
  );
  return (
    <>
      {speech && blocks ? (
        <View style={{ marginTop: props.marginTop, marginBottom: props.marginBottom }}>
          {blocks.map((block, index) => (
            <SpeechBlock key={index} index={index} speech={speech}>
              <MobileEnrichedMarkdownText
                {...markdownProps}
                markdown={block}
                marginTop={0}
                marginBottom={0}
              />
            </SpeechBlock>
          ))}
        </View>
      ) : (
        <MobileEnrichedMarkdownText {...markdownProps} />
      )}
      {citation ? (
        <AssistantCitationSheet citation={citation} onClose={() => setCitation(null)} />
      ) : null}
    </>
  );
}

/**
 * Watches raw touches instead of claiming them, so links, text selection, and horizontal
 * scrolling inside the block keep working.
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

// Negative margins keep the text where it sits outside reading mode.
const styles = StyleSheet.create({
  speechBlock: {
    borderRadius: 8,
    marginHorizontal: -6,
    marginVertical: -3,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
});
