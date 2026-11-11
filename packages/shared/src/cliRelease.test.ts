import { describe, expect, it } from "vite-plus/test";

import { cliArchiveTarCommand, newestCliReleaseVersion, parseChecksums } from "./cliRelease.ts";

describe("cliRelease", () => {
  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("picks the newest non-draft release on the requested channel", () => {
    const releases = [
      { tag_name: "v1.2.4-preview.20260912.9", draft: true },
      { tag_name: "v1.2.4-preview.20260912.8" },
      { tag_name: "v1.2.4-nightly.20260912.7" },
      { tag_name: "desktop-preview" },
      { tag_name: "v1.2.3" },
      { tag_name: "v1.2.3-nightly.20260911.2" },
    ];
    expect(newestCliReleaseVersion(releases, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.2.3");
    expect(newestCliReleaseVersion([{ tag_name: "v1.2.3" }], "preview")).toBeUndefined();
  });

  it("compares versions instead of trusting GitHub's list order", () => {
    const releases = [
      { tag_name: "v0.1.6-fork.9" },
      { tag_name: "v0.1.6-fork.8" },
      { tag_name: "v0.1.6-fork.24" },
      { tag_name: "v0.1.6-fork.10" },
      { tag_name: "v0.1.9" },
      { tag_name: "v0.1.10" },
      { tag_name: "v0.1.6-nightly.20260912.9" },
      { tag_name: "v0.1.6-nightly.20260912.10" },
      { tag_name: "v0.1.6-nightly.20260913.1" },
    ];
    expect(newestCliReleaseVersion(releases, "stable")).toBe("0.1.10");
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("0.1.6-nightly.20260913.1");
    expect(newestCliReleaseVersion(releases.slice(0, 4), "stable")).toBe("0.1.6-fork.24");
  });
});
