import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { requireNativeModule } from "expo";
import Constants from "expo-constants";
import { Atom } from "effect/unstable/reactivity";
import { useEffect } from "react";

import { environmentCatalog } from "../connection/catalog";
import { environmentSnapshotAtom } from "../state/shell";

const NativeControls = requireNativeModule<{
  syncNewChatWidgetProjects(json: string): void;
}>("T3NativeControls");

const widgetEnvironmentProjectsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => get(environmentSnapshotAtom(environmentId))?.projects ?? null),
);

const widgetProjectsAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  if (!catalog.isReady) return null;
  return JSON.stringify(
    [...catalog.entries].map(([environmentId, entry]) => {
      const projects = get(widgetEnvironmentProjectsAtom(environmentId));
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

export function NewChatWidgetSync() {
  const projects = useAtomValue(widgetProjectsAtom);
  useEffect(() => {
    if (projects !== null && Constants.expoConfig?.extra?.iosWidgetsEnabled !== false) {
      NativeControls.syncNewChatWidgetProjects(projects);
    }
  }, [projects]);
  return null;
}
