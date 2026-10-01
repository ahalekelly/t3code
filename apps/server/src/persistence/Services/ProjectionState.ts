/**
 * ProjectionStateRepository - Projection repository interface for projector cursors.
 *
 * Owns persistence operations for projection cursor state used to resume
 * incremental event projection.
 *
 * @module ProjectionStateRepository
 */
import { IsoDateTime, NonNegativeInt } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionState = Schema.Struct({
  projector: Schema.String,
  lastAppliedSequence: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type ProjectionState = typeof ProjectionState.Type;

/**
 * ProjectionStateRepositoryShape - Service API for projector state records.
 */
export interface ProjectionStateRepositoryShape {
  /**
   * Insert or replace a projection cursor row.
   *
   * Upserts by projector name.
   */
  readonly upsert: (row: ProjectionState) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Insert or replace projector cursors in one statement. Empty batches do nothing. */
  readonly upsertMany: (
    rows: ReadonlyArray<ProjectionState>,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * List all projector cursor rows.
   */
  readonly listAll: () => Effect.Effect<ReadonlyArray<ProjectionState>, ProjectionRepositoryError>;
}

/**
 * ProjectionStateRepository - Service tag for projection cursor persistence.
 */
export class ProjectionStateRepository extends Context.Service<
  ProjectionStateRepository,
  ProjectionStateRepositoryShape
>()("t3/persistence/Services/ProjectionState/ProjectionStateRepository") {}
