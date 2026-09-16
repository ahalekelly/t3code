import { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";
import type { WorkspaceEnvironment } from "../../state/workspaceModel";
import { projectSnapshotPending } from "./projectSnapshotPending";

const environment: WorkspaceEnvironment = {
  environmentId: EnvironmentId.make("widget-environment"),
  environmentLabel: "Desktop",
  displayUrl: "https://desktop.example",
  isRelayManaged: false,
  isEnabled: true,
  connectionState: "connecting",
  connectionError: null,
  connectionErrorTraceId: null,
};

const empty: EnvironmentShellState = {
  snapshot: Option.none(),
  error: Option.none(),
  status: "empty",
};
const shell = { data: empty, error: null, isPending: false };

describe("waiting for a linked project's environment", () => {
  it("waits for the selected environment to deliver its projects", () => {
    expect(projectSnapshotPending(environment, shell)).toBe(true);
    expect(projectSnapshotPending({ ...environment, connectionState: "connected" }, shell)).toBe(
      true,
    );
  });

  it("waits for cached projects to load even when the environment is offline", () => {
    expect(
      projectSnapshotPending(
        { ...environment, connectionState: "offline" },
        { ...shell, isPending: true },
      ),
    ).toBe(true);
  });

  it("uses a loaded snapshot immediately, including an empty project's catalog", () => {
    expect(
      projectSnapshotPending(environment, {
        ...shell,
        isPending: true,
        data: {
          ...empty,
          status: "cached",
          snapshot: Option.some({
            snapshotSequence: 0,
            projects: [],
            threads: [],
            updatedAt: "2026-09-15T12:00:00Z",
          }),
        },
      }),
    ).toBe(false);
  });

  it("does not wait forever for an offline or removed environment", () => {
    expect(projectSnapshotPending({ ...environment, connectionState: "offline" }, shell)).toBe(
      false,
    );
    expect(projectSnapshotPending(undefined, shell)).toBe(false);
  });

  it("ends loading when connection or snapshot loading fails", () => {
    expect(projectSnapshotPending({ ...environment, connectionState: "error" }, shell)).toBe(false);
    expect(projectSnapshotPending(environment, { ...shell, error: "Could not load cache" })).toBe(
      false,
    );
    expect(
      projectSnapshotPending(environment, {
        ...shell,
        data: { ...empty, error: Option.some("Could not load projects") },
      }),
    ).toBe(false);
  });
});
