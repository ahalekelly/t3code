import { describe, expect, it } from "vite-plus/test";

import { markdownSpeechText } from "./markdownSpeechText";

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

  it("separates headings, list items, code, and table cells for speech", () => {
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
          { type: "code_block", language: "sh", content: "echo hello" },
          {
            type: "table_row",
            children: [
              { type: "table_cell", children: [{ type: "text", content: "Name" }] },
              { type: "table_cell", children: [{ type: "text", content: "Value" }] },
            ],
          },
        ],
      }),
    ).toBe("Steps\nFirst\nSecond\necho hello\nName; Value;\n");
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
});
