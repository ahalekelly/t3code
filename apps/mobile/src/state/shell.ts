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
import { Atom } from "effect/reactivity";

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

const EMPTY_ENVIRONMENT_SHELL_STATE_ATOM = Atom.make<EnvironmentShellState>({
  snapshot: Option.none(),
  status: "empty",
  error: Option.none(),
});

const shellStatus = (state: EnvironmentShellState) => state.status;
const shellHasError = (state: EnvironmentShellState) => Option.isSome(state.error);

/** Snapshot contents do not affect whether the route is still hydrating. */
export function useEnvironmentShellReadiness(environmentId: EnvironmentId | null) {
  const atom =
    environmentId === null
      ? EMPTY_ENVIRONMENT_SHELL_STATE_ATOM
      : environmentShell.stateValueAtom(environmentId);
  return {
    status: useAtomValue(atom, shellStatus),
    hasError: useAtomValue(atom, shellHasError),
  };
}
