import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import * as Option from "effect/Option";
import type { EnvironmentQueryView } from "../../state/query";
import type { WorkspaceEnvironment } from "../../state/workspaceModel";

export function projectSnapshotPending(
  environment: WorkspaceEnvironment | undefined,
  shell: Pick<EnvironmentQueryView<EnvironmentShellState>, "data" | "error" | "isPending">,
): boolean {
  if (!environment || shell.error !== null) return false;
  if (shell.data && Option.isSome(shell.data.snapshot)) return false;
  if (shell.isPending) return true;
  if (shell.data && Option.isSome(shell.data.error)) return false;
  return environment.connectionState !== "offline" && environment.connectionState !== "error";
}
