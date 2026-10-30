import { expect, it } from "vite-plus/test";

import { shouldUseMarkdownFileBrowserPrimaryAction } from "./MarkdownFileLink.logic";

it("uses the browser for other files only when no other destination exists", () => {
  expect(
    shouldUseMarkdownFileBrowserPrimaryAction({
      iconPath: "notes.md",
      line: undefined,
      canOpenInEditor: true,
      canOpenInBrowser: true,
      canOpenInPanel: true,
    }),
  ).toBe(false);
  expect(
    shouldUseMarkdownFileBrowserPrimaryAction({
      iconPath: "notes.md",
      line: undefined,
      canOpenInEditor: false,
      canOpenInBrowser: true,
      canOpenInPanel: true,
    }),
  ).toBe(false);
  expect(
    shouldUseMarkdownFileBrowserPrimaryAction({
      iconPath: "notes.md",
      line: undefined,
      canOpenInEditor: false,
      canOpenInBrowser: true,
      canOpenInPanel: false,
    }),
  ).toBe(true);
});
