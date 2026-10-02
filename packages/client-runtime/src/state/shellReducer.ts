import * as Arr from "effect/Array";
import * as Equal from "effect/Equal";
import type { OrchestrationShellSnapshot, OrchestrationShellStreamEvent } from "@t3tools/contracts";

/**
 * Reduce a single shell stream event into an existing snapshot, returning a new
 * snapshot with the event's changes applied. This is a pure reducer that both
 * web and mobile can use to keep their local shell snapshot in sync.
 *
 * Returns the original snapshot reference unchanged if the event is not
 * recognized (forward-compatible).
 */
export function applyShellStreamEvent(
  snapshot: OrchestrationShellSnapshot,
  event: OrchestrationShellStreamEvent,
): OrchestrationShellSnapshot {
  if (event.sequence <= snapshot.snapshotSequence) return snapshot;

  switch (event.kind) {
    case "project-upserted": {
      const projects = snapshot.projects.some((p) => p.id === event.project.id)
        ? Arr.map(snapshot.projects, (p) => (p.id === event.project.id ? event.project : p))
        : Arr.append(snapshot.projects, event.project);
      return { ...snapshot, projects, snapshotSequence: event.sequence };
    }
    case "project-removed":
      return {
        ...snapshot,
        projects: Arr.filter(snapshot.projects, (p) => p.id !== event.projectId),
        snapshotSequence: event.sequence,
      };
    case "thread-upserted": {
      const threads = snapshot.threads.some((t) => t.id === event.thread.id)
        ? Arr.map(snapshot.threads, (t) => (t.id === event.thread.id ? event.thread : t))
        : Arr.append(snapshot.threads, event.thread);
      return { ...snapshot, threads, snapshotSequence: event.sequence };
    }
    case "thread-removed":
      return {
        ...snapshot,
        threads: Arr.filter(snapshot.threads, (t) => t.id !== event.threadId),
        snapshotSequence: event.sequence,
      };
    default:
      return snapshot;
  }
}

function reuseUnchanged<Entity extends { readonly id: string }>(
  previous: ReadonlyArray<Entity>,
  next: ReadonlyArray<Entity>,
): ReadonlyArray<Entity> {
  const previousById = new Map(previous.map((entity) => [entity.id, entity] as const));
  const reused = next.map((entity) => {
    const match = previousById.get(entity.id);
    return match !== undefined && Equal.equals(match, entity) ? match : entity;
  });
  return reused.length === previous.length &&
    reused.every((entity, index) => entity === previous[index])
    ? previous
    : reused;
}

/**
 * Prepares a full snapshot that replaces `previous`: every project and thread
 * deep-equal to its previous version keeps the previous object, and a list with
 * no changes keeps the previous array. Clients compare entities by reference, so
 * a reconnect that reloads an unchanged shell re-renders nothing.
 */
export function reuseUnchangedShellEntities(
  previous: OrchestrationShellSnapshot,
  next: OrchestrationShellSnapshot,
): OrchestrationShellSnapshot {
  const projects = reuseUnchanged(previous.projects, next.projects);
  const threads = reuseUnchanged(previous.threads, next.threads);
  return projects === next.projects && threads === next.threads
    ? next
    : { ...next, projects, threads };
}
