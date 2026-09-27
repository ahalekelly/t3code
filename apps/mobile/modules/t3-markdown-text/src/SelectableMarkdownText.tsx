import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { parseMarkdownWithOptions } from "react-native-nitro-markdown/headless";

import {
  nativeMarkdownChunkSpacing,
  nativeMarkdownDocumentChunks,
  nativeMarkdownDocumentRuns,
  nativeMarkdownWithPreservedSoftBreaks,
} from "./nativeMarkdownText";
import { MarkdownImageRendererContext, NativeMarkdownBlock } from "./NativeMarkdownBlock";
import {
  MarkdownContextClipboardContext,
  MarkdownFileContextMenuContext,
  NativeMarkdownSelectableText,
  type MarkdownFileContextMenuHandlers,
} from "./NativeMarkdownSelectableText";
import type {
  MarkdownSpeechBlocks,
  SelectableMarkdownSkill,
  SelectableMarkdownTextProps,
} from "./SelectableMarkdownText.types";

const EMPTY_SKILLS: ReadonlyArray<SelectableMarkdownSkill> = [];

export type {
  MarkdownSpeechBlocks,
  MarkdownCodeHighlighter,
  MarkdownHighlightedToken,
  MarkdownImageRenderer,
  MarkdownImageRequest,
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
  SelectableMarkdownTextProps,
} from "./SelectableMarkdownText.types";

export function hasNativeSelectableMarkdownText(): boolean {
  return true;
}

export function SelectableMarkdownText({
  markdown,
  contextClipboardFragment,
  skills = EMPTY_SKILLS,
  textStyle,
  highlightCode,
  preserveSoftBreaks = false,
  onLinkPress,
  fileContextMenu,
  onFileContextMenuAction,
  renderImage,
  marginTop = 0,
  marginBottom = 0,
  speech,
}: SelectableMarkdownTextProps) {
  const separateBlocks = speech !== undefined;
  const chunks = useMemo(() => {
    const parsedDocument = parseMarkdownWithOptions(markdown, {
      gfm: true,
      html: true,
      math: false,
    });
    const document = preserveSoftBreaks
      ? nativeMarkdownWithPreservedSoftBreaks(parsedDocument)
      : parsedDocument;
    return nativeMarkdownDocumentChunks(document, separateBlocks).map((chunk) =>
      chunk.kind === "selectable"
        ? {
            ...chunk,
            runs: nativeMarkdownDocumentRuns(chunk.node, skills),
          }
        : chunk,
    );
  }, [markdown, preserveSoftBreaks, separateBlocks, skills]);

  const fileContextMenuHandlers = useMemo<MarkdownFileContextMenuHandlers | null>(
    () =>
      fileContextMenu && onFileContextMenuAction
        ? { fileContextMenu, onFileContextMenuAction }
        : null,
    [fileContextMenu, onFileContextMenuAction],
  );

  return (
    <MarkdownContextClipboardContext.Provider value={contextClipboardFragment ?? ""}>
      <MarkdownImageRendererContext.Provider value={renderImage ?? null}>
        <MarkdownFileContextMenuContext.Provider value={fileContextMenuHandlers}>
          {/* A percentage width here creates a cyclic intrinsic measurement inside
          shrink-to-fit containers such as user-message bubbles. Yoga then gives
          the native text node an unbounded second pass and the parent only clips
          the resulting single-line width instead of reflowing it. */}
          <View style={{ flexShrink: 1, minWidth: 0, marginTop, marginBottom }}>
            {chunks.map((chunk, index) => {
              const content =
                chunk.kind === "rich" ? (
                  <NativeMarkdownBlock
                    node={chunk.node}
                    skills={skills}
                    textStyle={textStyle}
                    highlightCode={highlightCode}
                    onLinkPress={onLinkPress}
                  />
                ) : (
                  <NativeMarkdownSelectableText
                    runs={chunk.runs}
                    textStyle={textStyle}
                    onLinkPress={onLinkPress}
                  />
                );

              return (
                <View
                  key={chunk.key}
                  style={{ paddingTop: nativeMarkdownChunkSpacing(chunks[index - 1], chunk) }}
                >
                  {speech ? (
                    <SpeechBlock index={index} speech={speech}>
                      {content}
                    </SpeechBlock>
                  ) : (
                    content
                  )}
                </View>
              );
            })}
          </View>
        </MarkdownFileContextMenuContext.Provider>
      </MarkdownImageRendererContext.Provider>
    </MarkdownContextClipboardContext.Provider>
  );
}

/** One chunk per top-level block while reading, so the index matches the spoken block. */
function SpeechBlock(props: {
  readonly index: number;
  readonly speech: MarkdownSpeechBlocks;
  readonly children: ReactNode;
}) {
  const ref = useRef<View>(null);
  const active = props.speech.activeBlock === props.index;
  const { revealBlock } = props.speech;
  useEffect(() => {
    if (active && ref.current) revealBlock(ref.current);
  }, [active, revealBlock]);
  return (
    <View
      ref={ref}
      style={[styles.speechBlock, active && { backgroundColor: props.speech.highlightColor }]}
    >
      {props.children}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Read from here"
        style={StyleSheet.absoluteFill}
        onPress={() => props.speech.onPressBlock(props.index)}
      />
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
