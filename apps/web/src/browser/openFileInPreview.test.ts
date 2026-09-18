import {
  DEFAULT_CLIENT_SETTINGS,
  type AssetCreateUrlResult,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { resetPreviewStateForTests } from "~/previewStateStore";
import { openFileInBrowser } from "./openFileInPreview";

const shell = vi.hoisted(() => ({ openExternal: vi.fn(async (_url: string) => undefined) }));
vi.mock("~/localApi", () => ({ readLocalApi: () => ({ shell }) }));
vi.mock("~/previewStateStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/previewStateStore")>()),
  isPreviewSupportedInRuntime: () => true,
}));

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};
const url = "https://environment.example/api/assets/signed/report.html";
function input(target: "system" | "app") {
  return {
    target,
    threadRef,
    filePath: "/workspace/report.html",
    workspaceRoot: "/workspace",
    httpBaseUrl: "https://environment.example",
    createAssetUrl: vi.fn(async () =>
      AsyncResult.success({
        relativeUrl: "/api/assets/signed/report.html",
        expiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
      }),
    ),
    openPreview: vi.fn(async () =>
      AsyncResult.success({
        threadId: threadRef.threadId,
        tabId: "tab-1",
        navStatus: { _tag: "Loading" as const, url, title: "" },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-09-18T00:00:00.000Z",
      }),
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPreviewStateForTests();
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
});

describe("file browser destination", () => {
  it.each([
    ["/workspace/report.html", "workspace-file"],
    ["/tmp/report.html", "media-file"],
  ] as const)("opens %s in the default browser when selected", async (filePath, kind) => {
    const options = { ...input("system"), filePath };
    await expect(openFileInBrowser(options)).resolves.toMatchObject({ _tag: "Success" });
    expect(options.createAssetUrl).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: { resource: { _tag: kind, threadId: threadRef.threadId, path: filePath } },
    });
    expect(shell.openExternal).toHaveBeenCalledWith(url);
    expect(options.openPreview).not.toHaveBeenCalled();
  });

  it("keeps an explicit integrated-browser open in T3", async () => {
    const options = input("app");
    await expect(openFileInBrowser(options)).resolves.toMatchObject({ _tag: "Success" });
    expect(options.openPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ url }),
      }),
    );
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("does not open either browser when creating the file URL fails", async () => {
    const options = input("system");
    const failure = AsyncResult.failure<AssetCreateUrlResult, Error>(
      Cause.fail(new Error("File unavailable")),
    );
    await expect(
      openFileInBrowser({ ...options, createAssetUrl: async () => failure }),
    ).resolves.toMatchObject({ _tag: "Failure" });
    expect(options.openPreview).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});
