import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import {
  createEnvironmentShellAtoms,
  createEnvironmentShellSummaryAtom,
  createEnvironmentSnapshotAtom,
  createShellEnvironmentAtoms,
  EMPTY_SHELL_STATE,
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
 * show cached threads at once instead of a connecting state.
 */
export const shellCachesLoadedAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  if (!catalog.isReady) return false;
  for (const environmentId of enabledEnvironmentIds(catalog)) {
    if (get(environmentShell.stateValueAtom(environmentId)) === EMPTY_SHELL_STATE) return false;
  }
  return true;
}).pipe(Atom.withLabel("mobile-shell-caches-loaded"));

/** Set once the home list has painted its launch content, so the launch screen can hide over it. */
export const homeLaunchPaintedAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-home-launch-painted"),
);

const EMPTY_ENVIRONMENT_SHELL_STATE_ATOM = Atom.make(AsyncResult.success(EMPTY_SHELL_STATE)).pipe(
  Atom.withLabel("mobile-environment-shell:empty"),
);

/** Reads one environment's shell projection without waiting on other environments. */
export function useEnvironmentShellState(environmentId: EnvironmentId | null) {
  const result = useAtomValue(
    environmentId === null
      ? EMPTY_ENVIRONMENT_SHELL_STATE_ATOM
      : environmentShell.stateAtom(environmentId),
  );
  return Option.getOrElse(AsyncResult.value(result), () => EMPTY_SHELL_STATE);
}
