import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

export function useThreadListV2ShelfPreferences() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const snoozedShelfExpanded =
    loaded && preferencesResult.value.threadListSnoozedShelfExpanded === true;
  const settledShelfExpanded =
    loaded && preferencesResult.value.threadListSettledShelfExpanded === true;
  const projectFoldersEnabled = loaded && preferencesResult.value.projectFoldersEnabled === true;
  // Folders already separate the work, so grouping by project has no Working shelf.
  const workingShelfEnabled =
    loaded && !projectFoldersEnabled && preferencesResult.value.workingShelfEnabled !== false;
  // Working order and folder order are both by time, so neither lets the user move active threads.
  const activeReorderable = !workingShelfEnabled && !projectFoldersEnabled;
  const workingShelfExpanded =
    loaded && preferencesResult.value.threadListWorkingShelfExpanded === true;
  const collapsedProjectFolders = useMemo(
    () => new Set(loaded ? (preferencesResult.value.collapsedProjectFolders ?? []) : []),
    [loaded, preferencesResult],
  );

  // Transforms read optimistic state so same-frame presses toggle twice.
  const toggleSnoozedShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListSnoozedShelfExpanded: current.threadListSnoozedShelfExpanded !== true,
      }),
    });
  };
  const toggleSettledShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListSettledShelfExpanded: current.threadListSettledShelfExpanded !== true,
      }),
    });
  };
  const toggleWorkingShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListWorkingShelfExpanded: current.threadListWorkingShelfExpanded !== true,
      }),
    });
  };

  const toggleProjectFolder = (key: string) => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => {
        const collapsed = current.collapsedProjectFolders ?? [];
        return {
          collapsedProjectFolders: collapsed.includes(key)
            ? collapsed.filter((entry) => entry !== key)
            : [...collapsed, key],
        };
      },
    });
  };

  return {
    loaded,
    settledShelfExpanded,
    snoozedShelfExpanded,
    workingShelfEnabled,
    workingShelfExpanded,
    projectFoldersEnabled,
    activeReorderable,
    collapsedProjectFolders,
    toggleSettledShelf,
    toggleSnoozedShelf,
    toggleWorkingShelf,
    toggleProjectFolder,
  } as const;
}
