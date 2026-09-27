import { describe, expect, it } from "vite-plus/test";

import { markdownSpeechText, speechBlocks, unsentSpeechBlocks } from "./markdownSpeechText";

describe("markdownSpeechText", () => {
  it("reads formatted text, link labels and image descriptions without their markup or URLs", () => {
    expect(
      markdownSpeechText({
        type: "paragraph",
        children: [
          { type: "bold", children: [{ type: "text", content: "Read" }] },
          { type: "text", content: " the " },
          {
            type: "link",
            href: "https://example.com",
            children: [{ type: "italic", children: [{ type: "text", content: "guide" }] }],
          },
          { type: "soft_break" },
          { type: "image", alt: "A diagram", href: "https://example.com/image.png" },
        ],
      }),
    ).toBe("Read the guide A diagram\n");
  });

  it("separates headings, list items, code, and table cells for speech, summarizing code", () => {
    expect(
      markdownSpeechText({
        type: "document",
        children: [
          { type: "heading", children: [{ type: "text", content: "Steps" }] },
          {
            type: "list",
            children: [
              { type: "list_item", children: [{ type: "text", content: "First" }] },
              {
                type: "task_list_item",
                checked: true,
                children: [{ type: "text", content: "Second" }],
              },
            ],
          },
          { type: "code_block", language: "sh", content: "echo hello\necho bye\n" },
          {
            type: "table_row",
            children: [
              { type: "table_cell", children: [{ type: "text", content: "Name" }] },
              { type: "table_cell", children: [{ type: "text", content: "Value" }] },
            ],
          },
        ],
      }),
    ).toBe("Steps\nFirst\nSecond\nCode block, 2 lines.\nName; Value;\n");
  });

  it("omits HTML tags and separators while preserving inline code and explicit breaks", () => {
    expect(
      markdownSpeechText({
        type: "document",
        children: [
          { type: "html_inline", content: "<span>" },
          { type: "code_inline", content: "foo_bar" },
          { type: "html_inline", content: "</span>" },
          { type: "horizontal_rule" },
          { type: "line_break" },
          { type: "text", content: "Done & dusted." },
        ],
      }),
    ).toBe("foo_bar\nDone & dusted.");
  });

  it("keeps one entry per top-level block so indices match the rendered message", () => {
    const text = (content: string) => ({ type: "text" as const, content });
    expect(
      speechBlocks({
        type: "document",
        children: [
          { type: "heading", children: [text("Plan")] },
          { type: "paragraph", children: [text("First paragraph.")] },
          { type: "horizontal_rule" },
          {
            type: "list",
            children: [
              { type: "list_item", children: [text("one")] },
              { type: "list_item", children: [text("two")] },
            ],
          },
          { type: "code_block", language: "ts", content: "const a = 1;\n" },
        ],
      }),
    ).toEqual(["Plan", "First paragraph.", "", "one\ntwo", "Code block, 1 line."]);
  });
});

describe("unsentSpeechBlocks", () => {
  it("holds back the growing last block while streaming", () => {
    expect(unsentSpeechBlocks([], ["One.", "Tw"], true)).toEqual(["One."]);
    expect(unsentSpeechBlocks(["One."], ["One.", "Two.", "Thr"], true)).toEqual(["Two."]);
    expect(unsentSpeechBlocks(["One.", "Two."], ["One.", "Two.", "Three."], false)).toEqual([
      "Three.",
    ]);
  });

  it("waits while a reparse changes blocks that were already sent", () => {
    expect(unsentSpeechBlocks(["One."], ["One. More", "Two.", "Three"], true)).toEqual([]);
    expect(unsentSpeechBlocks(["One."], ["One. More", "Two."], false)).toEqual(["Two."]);
  });
});
