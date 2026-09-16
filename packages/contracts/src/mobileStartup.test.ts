import { expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";

it("loads contracts and validates monograms without Intl.Segmenter", async () => {
  const segmenter = Object.getOwnPropertyDescriptor(Intl, "Segmenter")!;
  Object.defineProperty(Intl, "Segmenter", { value: undefined, configurable: true });
  vi.resetModules();
  try {
    const { ProjectMonogramText } = await import("./index.ts");
    const decode = Schema.decodeUnknownSync(ProjectMonogramText);
    for (const text of ["T3", "e\u0301", "किखि", "文書"]) {
      expect(decode(text)).toBe(text);
    }
    for (const text of ["ABC", "किखिगि", "🚀"]) {
      expect(() => decode(text)).toThrow();
    }
  } finally {
    Object.defineProperty(Intl, "Segmenter", segmenter);
  }
});
