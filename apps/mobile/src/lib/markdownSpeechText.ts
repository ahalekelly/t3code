import type { Nodes, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { markdownWithHtml } from "./markdownDocument";

const parser = unified().use(remarkParse).use(remarkGfm);

/** Keeps spoken content and block breaks without reading Markdown syntax, link targets, or code. */
export function markdownSpeechText(node: Nodes): string {
  switch (node.type) {
    case "thematicBreak":
    case "definition":
    case "footnoteReference":
      return "";
    case "image":
    case "imageReference":
      return node.alt ?? "";
    case "break":
      return "\n";
    // mdast keeps soft line breaks inside text; speech reads them as spaces.
    case "text":
      return node.value.replace(/\n/g, " ");
    case "inlineCode":
      return node.value;
    case "code": {
      const lines = node.value.split("\n").length;
      return `Code block, ${lines} ${lines === 1 ? "line" : "lines"}.\n`;
    }
  }

  const text = "children" in node ? node.children.map(markdownSpeechText).join("") : "";
  switch (node.type) {
    case "paragraph":
    case "heading":
    case "listItem":
    case "tableRow":
      return `${text.trim()}\n`;
    case "tableCell":
      return `${text.trim()}; `;
    // A GitHub alert renders its type as a title, so its marker is not read.
    case "blockquote":
      return text.replace(/^\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i, "");
    default:
      return text;
  }
}

/** A top-level block of a message: its Markdown source to render and its spoken text. */
export interface MarkdownBlock {
  readonly markdown: string;
  readonly speech: string;
}

/**
 * The message's top-level blocks, in document order. Reading renders one view per block and
 * speaks one entry per block, so both come from this parse and their indices always match.
 * Silent blocks keep an empty `speech`. Link reference definitions are not blocks; every block
 * carries them so its references still resolve when rendered alone. HTML is converted first, as
 * the single-view render does, and each block keeps its first line's indent.
 */
export function markdownBlocks(original: string): MarkdownBlock[] {
  const markdown = markdownWithHtml(original);
  const nodes = parser.parse(markdown).children;
  const source = ({ position }: RootContent) =>
    markdown.slice(position!.start.offset! - position!.start.column + 1, position!.end.offset);
  const definitions = nodes
    .filter((node) => node.type === "definition")
    .map(source)
    .join("\n");
  return nodes
    .filter((node) => node.type !== "definition")
    .map((node) => ({
      markdown: definitions ? `${source(node)}\n\n${definitions}` : source(node),
      speech: markdownSpeechText(node).trim(),
    }));
}

/**
 * The blocks to send, replacing `sent` from index `from`, or null when nothing changed.
 * While a reply streams, its last block may still grow, so only earlier blocks count,
 * and nothing is sent while a reparse disagrees with what was already sent. The final
 * text replaces everything from the first block that changed.
 */
export function unsentSpeechBlocks(
  sent: readonly string[],
  blocks: readonly string[],
  streaming: boolean,
): { from: number; blocks: string[] } | null {
  const ready = streaming ? blocks.slice(0, -1) : blocks;
  let from = 0;
  while (from < sent.length && ready[from] === sent[from]) from++;
  if (from < sent.length ? streaming : ready.length === from) return null;
  return { from, blocks: ready.slice(from) };
}
