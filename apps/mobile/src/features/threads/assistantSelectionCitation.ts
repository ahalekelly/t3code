import type { AssistantCitation, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { createAssistantTextSelector } from "@t3tools/shared/assistantCitations";
import { markdownPlainText } from "@t3tools/shared/markdownPlainText";

/**
 * Native selections count offsets within one rendered block, so the quote's context comes from
 * the whole message's plain text, at the match nearest that block. Rendered text can differ from
 * the plain text (list markers, link pills); such a quote carries no context.
 */
export function assistantSelectionCitation(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly markdown: string;
  readonly blockOffset: number;
  readonly selection: { readonly text: string; readonly start: number };
}): AssistantCitation | null {
  const text = input.selection.text.trim();
  if (text.length === 0) return null;
  const plain = markdownPlainText(input.markdown);
  const quote = text.replace(/\s+/g, " ");
  const near =
    markdownPlainText(input.markdown.slice(0, input.blockOffset)).length + input.selection.start;
  let best = -1;
  for (let index = plain.indexOf(quote); index !== -1; index = plain.indexOf(quote, index + 1)) {
    if (best === -1 || Math.abs(index - near) < Math.abs(best - near)) best = index;
  }
  const context =
    best === -1
      ? { start: 0, end: 0, prefix: "", suffix: "" }
      : createAssistantTextSelector(plain, best, best + quote.length)!;
  return {
    version: 1,
    environmentId: input.environmentId,
    threadId: input.threadId,
    messageId: input.messageId,
    start: context.start,
    end: context.end,
    prefix: context.prefix,
    suffix: context.suffix,
    text,
  };
}
