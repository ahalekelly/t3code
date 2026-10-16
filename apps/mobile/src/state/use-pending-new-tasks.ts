import { useAtomValue } from "@effect/atom-react";
import * as Equivalence from "effect/Equivalence";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { isNewTaskDraftKey } from "./new-task-draft-key";
import { buildPendingNewTasks, type PendingNewTask } from "./pending-new-tasks-model";
import { flattenQueuedThreadMessages } from "./thread-outbox-model";
import { composerDraftsAtom, type ComposerDraft } from "./use-composer-drafts";
import { useThreadOutboxMessages } from "./use-thread-outbox";

export type {
  PendingDraftTask,
  PendingNewTask,
  PendingQueuedTask,
} from "./pending-new-tasks-model";

type DraftsByKey = Readonly<Record<string, ComposerDraft>>;

// Only new-task drafts become pending tasks. Typing in a thread composer
// replaces the drafts record on every keystroke; this keeps the thread list
// from re-rendering for drafts it never shows.
const newTaskDraftsAtom = Atom.make((get): DraftsByKey =>
  Object.fromEntries(
    Object.entries(get(composerDraftsAtom)).filter(([draftKey]) => isNewTaskDraftKey(draftKey)),
  ),
).pipe(
  Atom.withEquality(Equivalence.Record(Equivalence.strictEqual())),
  Atom.withLabel("mobile:new-task-drafts"),
);

export function usePendingNewTasks(): ReadonlyArray<PendingNewTask> {
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const drafts = useAtomValue(newTaskDraftsAtom);
  return useMemo(
    () =>
      buildPendingNewTasks({
        queuedMessages: flattenQueuedThreadMessages(queuedMessagesByThreadKey),
        drafts,
      }),
    [queuedMessagesByThreadKey, drafts],
  );
}
