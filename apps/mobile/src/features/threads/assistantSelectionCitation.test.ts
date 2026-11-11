import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { findAssistantCitationText } from "@t3tools/shared/assistantCitations";
import { markdownPlainText } from "@t3tools/shared/markdownPlainText";
import { describe, expect, it } from "vite-plus/test";

import { assistantSelectionCitation } from "./assistantSelectionCitation";

const cite = (markdown: string, blockOffset: number, text: string, start: number) =>
  assistantSelectionCitation({
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    messageId: MessageId.make("assistant"),
    markdown,
    blockOffset,
    selection: { text, start },
  });

describe("assistantSelectionCitation", () => {
  it("takes context from neighboring blocks so web can find the quote", () => {
    const markdown = "# Plan\n\nFirst **bold**\ntext here.\n\nSecond `para`.";
    const citation = cite(markdown, 0, "bold\ntext", 12);
    expect(citation).toMatchObject({
      text: "bold\ntext",
      prefix: "Plan First ",
      suffix: " here. Second para.",
    });
    expect(findAssistantCitationText(markdownPlainText(markdown), citation!)).toEqual({
      start: citation!.start,
      end: citation!.end,
    });
  });

  it("picks the repeated quote nearest the selected block", () => {
    const markdown = "Do it.\n\n```ts\nx\n```\n\nDo it again.";
    const second = markdown.lastIndexOf("Do it");
    expect(cite(markdown, second, "Do it", 0)?.start).toBe(
      markdownPlainText(markdown).lastIndexOf("Do it"),
    );
    expect(cite(markdown, 0, "Do it", 0)?.start).toBe(0);
  });

  it("keeps a quote the plain text lacks without context, and ignores blank selections", () => {
    expect(cite("- one\n- two", 0, "• one", 0)).toMatchObject({
      text: "• one",
      prefix: "",
      suffix: "",
    });
    expect(cite("Text", 0, " \n", 0)).toBeNull();
  });
});
