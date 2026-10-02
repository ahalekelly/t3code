import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import {
  createEnvironmentShellAtoms,
  createEnvironmentShellSummaryAtom,
  createEnvironmentSnapshotAtom,
  createShellEnvironmentAtoms,
  type EnvironmentShellState,
} from "@t3tools/client-runtime/state/shell";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";

export const shellEnvironment = createShellEnvironmentAtoms(connectionAtomRuntime);
export const environmentShell = createEnvironmentShellAtoms(connectionAtomRuntime);
export const environmentSnapshotAtom = createEnvironmentSnapshotAtom(environmentShell.stateAtom);
export const environmentShellSummaryAtom = createEnvironmentShellSummaryAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  shellStateValueAtom: environmentShell.stateValueAtom,
});

/**
 * Whether every enabled environment has read its cached shell, so a launch can
 * show cached threads at once instead of a connecting state. A loaded shell has
 * a snapshot or has started synchronizing; until then it reads as empty.
 */
export const shellCachesLoadedAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  if (!catalog.isReady) return false;
  for (const environmentId of enabledEnvironmentIds(catalog)) {
    const state = get(environmentShell.stateValueAtom(environmentId));
    if (Option.isNone(state.snapshot) && state.status === "empty") return false;
  }
  return true;
}).pipe(Atom.withLabel("mobile-shell-caches-loaded"));

const EMPTY_ENVIRONMENT_SHELL_STATE_ATOM = Atom.make(
  AsyncResult.success<EnvironmentShellState>({
    snapshot: Option.none(),
    status: "empty",
    error: Option.none(),
  }),
).pipe(Atom.withLabel("mobile-environment-shell:empty"));

/** Reads one environment's shell projection without waiting on other environments. */
export function useEnvironmentShellState(environmentId: EnvironmentId | null) {
  const result = useAtomValue(
    environmentId === null
      ? EMPTY_ENVIRONMENT_SHELL_STATE_ATOM
      : environmentShell.stateAtom(environmentId),
  );
  return Option.getOrElse(AsyncResult.value(result), () => ({
    snapshot: Option.none(),
    status: "empty" as const,
    error: Option.none(),
  }));
}
