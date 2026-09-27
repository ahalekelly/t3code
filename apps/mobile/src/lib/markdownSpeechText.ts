import type { MarkdownNode } from "react-native-nitro-markdown/headless";

/** Keeps spoken content and block breaks without reading Markdown syntax, link targets, or code. */
export function markdownSpeechText(node: MarkdownNode): string {
  switch (node.type) {
    case "horizontal_rule":
    case "html_block":
    case "html_inline":
      return "";
    case "image":
      return node.alt ?? "";
    case "soft_break":
      return " ";
    case "line_break":
      return "\n";
    case "code_block": {
      const lines = (node.content ?? "").replace(/\n$/, "").split("\n").length;
      return `Code block, ${lines} ${lines === 1 ? "line" : "lines"}.\n`;
    }
  }

  const text = node.content ?? node.children?.map(markdownSpeechText).join("") ?? "";
  switch (node.type) {
    case "paragraph":
    case "heading":
    case "math_block":
    case "list_item":
    case "task_list_item":
    case "table_row":
      return `${text.trim()}\n`;
    case "table_cell":
      return `${text.trim()}; `;
    default:
      return text;
  }
}

/**
 * The spoken text of each top-level block, in document order. Silent blocks stay as
 * empty strings so block indices match the rendered message's top-level nodes.
 */
export function speechBlocks(document: MarkdownNode): string[] {
  return (document.children ?? []).map((node) => markdownSpeechText(node).trim());
}

/**
 * The blocks to send after `sent`. While a reply streams, its last block may still
 * grow, so only earlier blocks count, and nothing is sent while a reparse disagrees
 * with what was already sent. The final text sends whatever remains.
 */
export function unsentSpeechBlocks(
  sent: readonly string[],
  blocks: readonly string[],
  streaming: boolean,
): string[] {
  if (!streaming) return blocks.slice(sent.length);
  const complete = blocks.slice(0, -1);
  return sent.every((text, index) => complete[index] === text) ? complete.slice(sent.length) : [];
}
