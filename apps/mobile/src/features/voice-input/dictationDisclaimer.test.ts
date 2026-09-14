import { describe, expect, it } from "vite-plus/test";

import { withDictationDisclaimer } from "./dictationDisclaimer";

describe("withDictationDisclaimer", () => {
  it("appends the disclaimer to dictated text", () => {
    expect(withDictationDisclaimer("ship the fix")).toBe(
      "ship the fix\n\n(voice transcription, may contain errors)",
    );
  });

  it("keeps one disclaimer when dictating into an already marked draft", () => {
    const once = withDictationDisclaimer("ship the fix");
    expect(withDictationDisclaimer(`${once} today`)).toBe(
      "ship the fix today\n\n(voice transcription, may contain errors)",
    );
  });

  it("marks empty text", () => {
    expect(withDictationDisclaimer("")).toBe("\n\n(voice transcription, may contain errors)");
  });
});
