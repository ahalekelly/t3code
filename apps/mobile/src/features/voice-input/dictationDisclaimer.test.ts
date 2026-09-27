import { describe, expect, it } from "vite-plus/test";

import { withDictationDisclaimer } from "./dictationDisclaimer";

describe("withDictationDisclaimer", () => {
  it("appends the disclaimer to dictated text", () => {
    expect(withDictationDisclaimer("ship the fix", false)).toBe(
      "ship the fix\n\n(voice transcription, may contain errors)",
    );
  });

  it("asks for a spoken-style reply when the reply will be read aloud", () => {
    expect(withDictationDisclaimer("ship the fix", true)).toMatch(
      /^ship the fix\n\n\(voice transcription, may contain errors\. Your reply will be read aloud/,
    );
  });

  it("keeps one disclaimer when dictating into an already marked draft", () => {
    const once = withDictationDisclaimer("ship the fix", true);
    expect(withDictationDisclaimer(`${once} today`, false)).toBe(
      "ship the fix today\n\n(voice transcription, may contain errors)",
    );
  });

  it("marks empty text", () => {
    expect(withDictationDisclaimer("", false)).toBe(
      "\n\n(voice transcription, may contain errors)",
    );
  });
});
