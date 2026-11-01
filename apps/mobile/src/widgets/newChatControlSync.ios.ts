import type { EnvironmentId } from "@t3tools/contracts";
import { requireNativeModule } from "expo";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../state/atom-registry";
import { environmentSnapshotAtom } from "../state/shell";

const NativeControls = requireNativeModule<{
  syncNewChatControlProjects(json: string): void;
}>("T3NativeControls");

const controlEnvironmentProjectsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => get(environmentSnapshotAtom(environmentId))?.projects ?? null),
);

const controlProjectsAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  if (!catalog.isReady) return null;
  return JSON.stringify(
    [...catalog.entries].map(([environmentId, entry]) => {
      const projects = get(controlEnvironmentProjectsAtom(environmentId));
      return {
        environmentId,
        label: entry.target.label,
        projects:
          projects?.map(({ id, title, workspaceRoot }) => ({
            id,
            title,
            workspaceRoot,
          })) ?? null,
      };
    }),
  );
});

export function installNewChatControlSync(): () => void {
  return appAtomRegistry.subscribe(
    controlProjectsAtom,
    (projects) => {
      if (projects !== null) NativeControls.syncNewChatControlProjects(projects);
    },
    { immediate: true },
  );
}
