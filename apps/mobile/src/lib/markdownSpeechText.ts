import type { MarkdownNode } from "react-native-nitro-markdown/headless";

/** Keeps spoken content and block breaks without reading Markdown syntax or link targets. */
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
  }

  const text = node.content ?? node.children?.map(markdownSpeechText).join("") ?? "";
  switch (node.type) {
    case "paragraph":
    case "heading":
    case "code_block":
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
