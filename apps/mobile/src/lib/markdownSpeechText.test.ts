import { describe, expect, it } from "vite-plus/test";

import { markdownWithHtml } from "./markdownDocument";
import { markdownBlocks, unsentSpeechBlocks } from "./markdownSpeechText";

const speech = (markdown: string) => markdownBlocks(markdown).map((block) => block.speech);

describe("markdownBlocks", () => {
  it("reads formatted text, link labels and image descriptions without their markup or URLs", () => {
    expect(
      speech(
        "**Read** the [*guide*](https://example.com)\n![A diagram](https://example.com/a.png)",
      ),
    ).toEqual(["Read the guide A diagram"]);
  });

  it("separates list items, code, and table cells for speech, summarizing code", () => {
    expect(
      speech(
        [
          "- First",
          "- [x] Second",
          "",
          "```sh",
          "echo hello",
          "echo bye",
          "```",
          "",
          "| Name | Value |",
          "| --- | --- |",
          "| a | b |",
        ].join("\n"),
      ),
    ).toEqual(["First\nSecond", "Code block, 2 lines.", "Name; Value;\na; b;"]);
  });

  it("omits HTML tags while preserving inline code and explicit breaks", () => {
    expect(speech("<span>`foo_bar`</span>  \nDone &amp; dusted.")).toEqual([
      "foo_bar\nDone & dusted.",
    ]);
  });

  it("keeps one entry per top-level block, with its source, so indices match the rendered blocks", () => {
    const markdown =
      "# Plan\n\nFirst paragraph.\n\n---\n\n- one\n- two\n\n```ts\nconst a = 1;\n```";
    expect(markdownBlocks(markdown)).toEqual([
      { markdown: "# Plan", speech: "Plan" },
      { markdown: "First paragraph.", speech: "First paragraph." },
      { markdown: "---", speech: "" },
      { markdown: "- one\n- two", speech: "one\ntwo" },
      { markdown: "```ts\nconst a = 1;\n```", speech: "Code block, 1 line." },
    ]);
  });

  it("carries link reference definitions into every block instead of making them blocks", () => {
    expect(markdownBlocks("See [docs][d].\n\nThen [docs][d].\n\n[d]: https://example.com")).toEqual(
      [
        { markdown: "See [docs][d].\n\n[d]: https://example.com", speech: "See docs." },
        { markdown: "Then [docs][d].\n\n[d]: https://example.com", speech: "Then docs." },
      ],
    );
  });

  it("reads HTML as rendered, with blocks that render unchanged on their own", () => {
    const blocks = markdownBlocks(
      "<details>\n<summary>More info</summary>\n\nHidden text.\n\n</details>",
    );
    expect(blocks.map((block) => block.speech)).toEqual(["More info", "Hidden text."]);
    for (const block of blocks) expect(markdownWithHtml(block.markdown)).toBe(block.markdown);
  });

  it("keeps the indent of a block's first line", () => {
    expect(markdownBlocks("Intro.\n\n  - one\n    more\n  - two")[1]!.markdown).toBe(
      "  - one\n    more\n  - two",
    );
  });

  it("does not read the marker of a GitHub alert", () => {
    expect(speech("> [!TIP]\n> Run it twice.\n\n> [!note] Inline.")).toEqual([
      "Run it twice.",
      "Inline.",
    ]);
  });
});

describe("unsentSpeechBlocks", () => {
  it("holds back the growing last block while streaming", () => {
    expect(unsentSpeechBlocks([], ["One.", "Tw"], true)).toEqual({ from: 0, blocks: ["One."] });
    expect(unsentSpeechBlocks(["One."], ["One.", "Two.", "Thr"], true)).toEqual({
      from: 1,
      blocks: ["Two."],
    });
    expect(unsentSpeechBlocks(["One."], ["One.", "Tw"], true)).toBeNull();
    expect(unsentSpeechBlocks(["One.", "Two."], ["One.", "Two.", "Three."], false)).toEqual({
      from: 2,
      blocks: ["Three."],
    });
    expect(unsentSpeechBlocks(["One."], ["One."], false)).toBeNull();
  });

  it("resends from a block that a reparse changed once the text is final", () => {
    expect(unsentSpeechBlocks(["One."], ["One. More", "Two.", "Three"], true)).toBeNull();
    expect(unsentSpeechBlocks(["One.", "Two."], ["One.", "Two, more.", "Three."], false)).toEqual({
      from: 1,
      blocks: ["Two, more.", "Three."],
    });
  });
});
