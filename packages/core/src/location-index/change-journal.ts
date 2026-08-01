export * as LocationChangeJournal from "./change-journal"

import { and, asc, eq, gt, inArray, lte, max, min, or } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { ProjectionKind, type IndexSpaceID } from "../context-federation/reference"
import { ChangeEventTable, ProjectionDirtyPathTable, ProjectionRegistrationTable } from "./sql"

const ReconcilePath = "*"

export type ChangeKind = typeof ChangeEventTable.$inferSelect.change_kind
export type ChangeSource = typeof ChangeEventTable.$inferSelect.source
export type RegistrationState = typeof ProjectionRegistrationTable.$inferSelect.state

export type Event = {
  readonly eventSeq: number
  readonly indexSpaceId: IndexSpaceID
  readonly path: string
  readonly previousPath?: string
  readonly renameCorrelationId?: string
  readonly changeKind: ChangeKind
  readonly observedMtimeNs?: string
  readonly observedSha?: string
  readonly source: ChangeSource
  readonly observedAt: number
}

export type Registration = {
  readonly indexSpaceId: IndexSpaceID
  readonly projectionKind: ProjectionKind
  readonly registrationEpoch: number
  readonly state: RegistrationState
  readonly consumedEventSeq: number
  readonly reconcileRequired: boolean
  readonly updatedAt: number
}

export type DirtyPath = {
  readonly path: string
  readonly latestEventSeq: number
  readonly previousPath?: string
  readonly renameCorrelationId?: string
  readonly changeKind: ChangeKind
  readonly observedMtimeNs?: string
  readonly observedSha?: string
}

export type Work = {
  readonly registration: Registration
  readonly capturedEventSeq: number
  readonly dirty: readonly DirtyPath[]
  readonly events: readonly Event[]
}

export class InvalidChangeError extends Schema.TaggedErrorClass<InvalidChangeError>()(
  "LocationChangeJournal.InvalidChangeError",
  { reason: Schema.String },
) {}

export class RegistrationError extends Schema.TaggedErrorClass<RegistrationError>()(
  "LocationChangeJournal.RegistrationError",
  { reason: Schema.String },
) {}

export type Error = InvalidChangeError | RegistrationError

export interface Interface {
  readonly register: (input: {
    readonly indexSpaceId: IndexSpaceID
    readonly projectionKind: ProjectionKind
    readonly now?: number
  }) => Effect.Effect<Registration, Error>
  readonly markReconciled: (input: {
    readonly indexSpaceId: IndexSpaceID
    readonly projectionKind: ProjectionKind
    readonly capturedEventSeq: number
    readonly now?: number
  }) => Effect.Effect<Registration, Error>
  readonly setState: (input: {
    readonly indexSpaceId: IndexSpaceID
    readonly projectionKind: ProjectionKind
    readonly state: RegistrationState
    readonly now?: number
  }) => Effect.Effect<Registration, Error>
  readonly append: (input: {
    readonly indexSpaceId: IndexSpaceID
    readonly path?: string
    readonly previousPath?: string
    readonly renameCorrelationId?: string
    readonly changeKind: ChangeKind
    readonly observedMtimeNs?: string
    readonly observedSha?: string
    readonly source: ChangeSource
    readonly observedAt?: number
  }) => Effect.Effect<Event, Error>
  readonly capture: (input: {
    readonly indexSpaceId: IndexSpaceID
    readonly projectionKind: ProjectionKind
  }) => Effect.Effect<Work, Error>
  readonly captureReconciliation: (input: {
    readonly indexSpaceId: IndexSpaceID
    readonly projectionKind: ProjectionKind
  }) => Effect.Effect<Work, Error>
  readonly acknowledge: (input: {
    readonly indexSpaceId: IndexSpaceID
    readonly projectionKind: ProjectionKind
    readonly capturedEventSeq: number
    readonly now?: number
  }) => Effect.Effect<Registration, Error>
  readonly compact: (input: {
    readonly indexSpaceId: IndexSpaceID
    readonly maxRetainedEvents: number
    readonly now?: number
  }) => Effect.Effect<{ readonly deleted: number; readonly highWater: number }, Error>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/LocationChangeJournal") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db

    const register = Effect.fn("LocationChangeJournal.register")(function* (
      input: Parameters<Interface["register"]>[0],
    ) {
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const current = yield* tx
            .select()
            .from(ProjectionRegistrationTable)
            .where(registrationWhere(input.indexSpaceId, input.projectionKind))
            .get()
          if (current && current.state !== "retired") return registration(current)
          const highWater = yield* highWaterFor(tx, input.indexSpaceId)
          const now = input.now ?? Date.now()
          const row = {
            index_space_id: input.indexSpaceId,
            projection_kind: input.projectionKind,
            registration_epoch: (current?.registration_epoch ?? 0) + 1,
            state: "paused" as const,
            consumed_event_seq: highWater,
            reconcile_required: true,
            updated_at: now,
          }
          yield* tx
            .insert(ProjectionRegistrationTable)
            .values(row)
            .onConflictDoUpdate({
              target: [ProjectionRegistrationTable.index_space_id, ProjectionRegistrationTable.projection_kind],
              set: row,
            })
            .run()
          yield* upsertReconcile(tx, input.indexSpaceId, input.projectionKind, highWater, now)
          return registration(row)
        }),
      ).pipe(preserveErrors)
    })

    const markReconciled = Effect.fn("LocationChangeJournal.markReconciled")(function* (
      input: Parameters<Interface["markReconciled"]>[0],
    ) {
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const current = yield* requireRegistration(tx, input.indexSpaceId, input.projectionKind)
          if (current.state === "retired") return yield* new RegistrationError({ reason: "retired" })
          const highWater = yield* highWaterFor(tx, input.indexSpaceId)
          if (
            input.capturedEventSeq < current.consumed_event_seq ||
            input.capturedEventSeq > highWater
          ) return yield* new RegistrationError({ reason: "invalid_reconcile_ack" })
          const now = input.now ?? Date.now()
          yield* tx
            .delete(ProjectionDirtyPathTable)
            .where(
              and(
                dirtyWhere(input.indexSpaceId, input.projectionKind),
                lte(ProjectionDirtyPathTable.latest_event_seq, input.capturedEventSeq),
              ),
            )
            .run()
          const updated = yield* tx
            .update(ProjectionRegistrationTable)
            .set({
              state: "active",
              reconcile_required: false,
              consumed_event_seq: input.capturedEventSeq,
              updated_at: now,
            })
            .where(registrationWhere(input.indexSpaceId, input.projectionKind))
            .returning()
            .get()
          if (!updated) return yield* new RegistrationError({ reason: "missing" })
          return registration(updated)
        }),
      ).pipe(preserveErrors)
    })

    const setState = Effect.fn("LocationChangeJournal.setState")(function* (
      input: Parameters<Interface["setState"]>[0],
    ) {
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const current = yield* requireRegistration(tx, input.indexSpaceId, input.projectionKind)
          if (current.state === "retired" && input.state !== "retired") {
            return yield* new RegistrationError({ reason: "register_after_retire" })
          }
          const now = input.now ?? Date.now()
          const updated = yield* tx
            .update(ProjectionRegistrationTable)
            .set({ state: input.state, updated_at: now })
            .where(registrationWhere(input.indexSpaceId, input.projectionKind))
            .returning()
            .get()
          if (!updated) return yield* new RegistrationError({ reason: "missing" })
          if (input.state === "retired") {
            yield* tx
              .delete(ProjectionDirtyPathTable)
              .where(dirtyWhere(input.indexSpaceId, input.projectionKind))
              .run()
          }
          return registration(updated)
        }),
      ).pipe(preserveErrors)
    })

    const append = Effect.fn("LocationChangeJournal.append")(function* (input: Parameters<Interface["append"]>[0]) {
      const path = input.path ?? ReconcilePath
      yield* validateChange({ ...input, path })
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const now = input.observedAt ?? Date.now()
          const row = yield* tx
            .insert(ChangeEventTable)
            .values({
              index_space_id: input.indexSpaceId,
              path,
              previous_path: input.previousPath,
              rename_correlation_id: input.renameCorrelationId,
              change_kind: input.changeKind,
              observed_mtime_ns: input.observedMtimeNs,
              observed_sha: input.observedSha,
              source: input.source,
              observed_at: now,
            })
            .returning()
            .get()
          if (!row) return yield* new InvalidChangeError({ reason: "insert" })
          const registrations = yield* tx
            .select()
            .from(ProjectionRegistrationTable)
            .where(
              and(
                eq(ProjectionRegistrationTable.index_space_id, input.indexSpaceId),
                inArray(ProjectionRegistrationTable.state, ["active", "paused"]),
              ),
            )
            .all()
          yield* Effect.forEach(
            registrations,
            (item) =>
              tx
                .insert(ProjectionDirtyPathTable)
                .values({
                  index_space_id: input.indexSpaceId,
                  projection_kind: item.projection_kind,
                  path,
                  latest_event_seq: row.event_seq,
                  previous_path: input.previousPath,
                  rename_correlation_id: input.renameCorrelationId,
                  change_kind: input.changeKind,
                  observed_mtime_ns: input.observedMtimeNs,
                  observed_sha: input.observedSha,
                  updated_at: now,
                })
                .onConflictDoUpdate({
                  target: [
                    ProjectionDirtyPathTable.index_space_id,
                    ProjectionDirtyPathTable.projection_kind,
                    ProjectionDirtyPathTable.path,
                  ],
                  set: {
                    latest_event_seq: row.event_seq,
                    previous_path: input.previousPath ?? null,
                    rename_correlation_id: input.renameCorrelationId ?? null,
                    change_kind: input.changeKind,
                    observed_mtime_ns: input.observedMtimeNs ?? null,
                    observed_sha: input.observedSha ?? null,
                    updated_at: now,
                  },
                })
                .run(),
            { discard: true },
          )
          return event(row)
        }),
      ).pipe(preserveErrors)
    })

    const capture = Effect.fn("LocationChangeJournal.capture")(function* (
      input: Parameters<Interface["capture"]>[0],
    ) {
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const current = yield* requireRegistration(tx, input.indexSpaceId, input.projectionKind)
          if (current.state !== "active" || current.reconcile_required) {
            return yield* new RegistrationError({ reason: current.reconcile_required ? "reconcile_required" : current.state })
          }
          const capturedEventSeq = yield* highWaterFor(tx, input.indexSpaceId)
          const dirty = yield* tx
            .select()
            .from(ProjectionDirtyPathTable)
            .where(
              and(
                dirtyWhere(input.indexSpaceId, input.projectionKind),
                lte(ProjectionDirtyPathTable.latest_event_seq, capturedEventSeq),
              ),
            )
            .orderBy(asc(ProjectionDirtyPathTable.path))
            .all()
          const events = yield* tx
            .select()
            .from(ChangeEventTable)
            .where(
              and(
                eq(ChangeEventTable.index_space_id, input.indexSpaceId),
                gt(ChangeEventTable.event_seq, current.consumed_event_seq),
                lte(ChangeEventTable.event_seq, capturedEventSeq),
              ),
            )
            .orderBy(asc(ChangeEventTable.event_seq))
            .all()
          return {
            registration: registration(current),
            capturedEventSeq,
            dirty: dirty.map(dirtyPath),
            events: events.map(event),
          }
        }),
      ).pipe(preserveErrors)
    })

    const captureReconciliation = Effect.fn("LocationChangeJournal.captureReconciliation")(function* (
      input: Parameters<Interface["captureReconciliation"]>[0],
    ) {
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const current = yield* requireRegistration(tx, input.indexSpaceId, input.projectionKind)
          if (current.state === "retired" || !current.reconcile_required) {
            return yield* new RegistrationError({ reason: "not_reconciling" })
          }
          const capturedEventSeq = yield* highWaterFor(tx, input.indexSpaceId)
          const dirty = yield* tx
            .select()
            .from(ProjectionDirtyPathTable)
            .where(
              and(
                dirtyWhere(input.indexSpaceId, input.projectionKind),
                lte(ProjectionDirtyPathTable.latest_event_seq, capturedEventSeq),
              ),
            )
            .orderBy(asc(ProjectionDirtyPathTable.path))
            .all()
          const events = yield* tx
            .select()
            .from(ChangeEventTable)
            .where(
              and(
                eq(ChangeEventTable.index_space_id, input.indexSpaceId),
                gt(ChangeEventTable.event_seq, current.consumed_event_seq),
                lte(ChangeEventTable.event_seq, capturedEventSeq),
              ),
            )
            .orderBy(asc(ChangeEventTable.event_seq))
            .all()
          return {
            registration: registration(current),
            capturedEventSeq,
            dirty: dirty.map(dirtyPath),
            events: events.map(event),
          }
        }),
      ).pipe(preserveErrors)
    })

    const acknowledge = Effect.fn("LocationChangeJournal.acknowledge")(function* (
      input: Parameters<Interface["acknowledge"]>[0],
    ) {
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const current = yield* requireRegistration(tx, input.indexSpaceId, input.projectionKind)
          if (current.state !== "active" || current.reconcile_required) {
            return yield* new RegistrationError({ reason: "inactive" })
          }
          if (input.capturedEventSeq < current.consumed_event_seq) {
            return yield* new RegistrationError({ reason: "non_monotonic_ack" })
          }
          const highWater = yield* highWaterFor(tx, input.indexSpaceId)
          if (input.capturedEventSeq > highWater) return yield* new RegistrationError({ reason: "future_ack" })
          yield* tx
            .delete(ProjectionDirtyPathTable)
            .where(
              and(
                dirtyWhere(input.indexSpaceId, input.projectionKind),
                lte(ProjectionDirtyPathTable.latest_event_seq, input.capturedEventSeq),
              ),
            )
            .run()
          const updated = yield* tx
            .update(ProjectionRegistrationTable)
            .set({ consumed_event_seq: input.capturedEventSeq, updated_at: input.now ?? Date.now() })
            .where(registrationWhere(input.indexSpaceId, input.projectionKind))
            .returning()
            .get()
          if (!updated) return yield* new RegistrationError({ reason: "missing" })
          return registration(updated)
        }),
      ).pipe(preserveErrors)
    })

    const compact = Effect.fn("LocationChangeJournal.compact")(function* (
      input: Parameters<Interface["compact"]>[0],
    ) {
      if (!Number.isSafeInteger(input.maxRetainedEvents) || input.maxRetainedEvents < 1) {
        return yield* new InvalidChangeError({ reason: "retention" })
      }
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const highWater = yield* highWaterFor(tx, input.indexSpaceId)
          const retentionFloor = Math.max(0, highWater - input.maxRetainedEvents)
          const laggingPaused = yield* tx
            .select()
            .from(ProjectionRegistrationTable)
            .where(
              and(
                eq(ProjectionRegistrationTable.index_space_id, input.indexSpaceId),
                eq(ProjectionRegistrationTable.state, "paused"),
                eq(ProjectionRegistrationTable.reconcile_required, false),
                lte(ProjectionRegistrationTable.consumed_event_seq, retentionFloor),
              ),
            )
            .all()
          const now = input.now ?? Date.now()
          yield* Effect.forEach(
            laggingPaused,
            (item) =>
              Effect.gen(function* () {
                yield* tx
                  .update(ProjectionRegistrationTable)
                  .set({ reconcile_required: true, consumed_event_seq: highWater, updated_at: now })
                  .where(registrationWhere(input.indexSpaceId, item.projection_kind))
                  .run()
                yield* tx
                  .delete(ProjectionDirtyPathTable)
                  .where(dirtyWhere(input.indexSpaceId, item.projection_kind))
                  .run()
                yield* upsertReconcile(tx, input.indexSpaceId, item.projection_kind, highWater, now)
              }),
            { discard: true },
          )
          const blocker = yield* tx
            .select({ value: min(ProjectionRegistrationTable.consumed_event_seq) })
            .from(ProjectionRegistrationTable)
            .where(
              and(
                eq(ProjectionRegistrationTable.index_space_id, input.indexSpaceId),
                or(
                  eq(ProjectionRegistrationTable.state, "active"),
                  and(
                    eq(ProjectionRegistrationTable.state, "paused"),
                    eq(ProjectionRegistrationTable.reconcile_required, false),
                  ),
                ),
              ),
            )
            .get()
          const through = Math.min(blocker?.value ?? highWater, retentionFloor)
          const deleted = yield* tx
            .delete(ChangeEventTable)
            .where(and(eq(ChangeEventTable.index_space_id, input.indexSpaceId), lte(ChangeEventTable.event_seq, through)))
            .returning({ event_seq: ChangeEventTable.event_seq })
            .all()
          return { deleted: deleted.length, highWater }
        }),
      ).pipe(preserveErrors)
    })

    return Service.of({
      register,
      markReconciled,
      setState,
      append,
      capture,
      captureReconciliation,
      acknowledge,
      compact,
    })
  }),
)

function validateChange(input: Parameters<Interface["append"]>[0] & { readonly path: string }) {
  const paths = [input.path, input.previousPath].filter((value): value is string => value !== undefined)
  if (paths.some((value) => value !== ReconcilePath && (!value || value.startsWith("/") || value.includes("\\") || value.split("/").includes("..")))) {
    return Effect.fail(new InvalidChangeError({ reason: "path" }))
  }
  if (input.changeKind === "rename" && (!input.previousPath || !input.renameCorrelationId)) {
    return Effect.fail(new InvalidChangeError({ reason: "rename_evidence" }))
  }
  if (input.changeKind === "rename" && !["git", "tool", "reconciliation"].includes(input.source)) {
    return Effect.fail(new InvalidChangeError({ reason: "untrusted_rename_source" }))
  }
  if (input.changeKind !== "rename" && (input.previousPath || input.renameCorrelationId)) {
    return Effect.fail(new InvalidChangeError({ reason: "unexpected_rename_evidence" }))
  }
  if (["overflow", "reconcile", "checkout"].includes(input.changeKind) && input.path !== ReconcilePath) {
    return Effect.fail(new InvalidChangeError({ reason: "global_change_path" }))
  }
  return Effect.void
}

function registrationWhere(indexSpaceId: IndexSpaceID, projectionKind: ProjectionKind) {
  return and(
    eq(ProjectionRegistrationTable.index_space_id, indexSpaceId),
    eq(ProjectionRegistrationTable.projection_kind, projectionKind),
  )
}

function dirtyWhere(indexSpaceId: IndexSpaceID, projectionKind: ProjectionKind) {
  return and(
    eq(ProjectionDirtyPathTable.index_space_id, indexSpaceId),
    eq(ProjectionDirtyPathTable.projection_kind, projectionKind),
  )
}

function requireRegistration(
  tx: Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0],
  indexSpaceId: IndexSpaceID,
  projectionKind: ProjectionKind,
) {
  return tx
    .select()
    .from(ProjectionRegistrationTable)
    .where(registrationWhere(indexSpaceId, projectionKind))
    .get()
    .pipe(Effect.flatMap((row) => row ? Effect.succeed(row) : Effect.fail(new RegistrationError({ reason: "missing" }))))
}

function highWaterFor(
  tx: Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0],
  indexSpaceId: IndexSpaceID,
) {
  return tx
    .select({ value: max(ChangeEventTable.event_seq) })
    .from(ChangeEventTable)
    .where(eq(ChangeEventTable.index_space_id, indexSpaceId))
    .get()
    .pipe(Effect.map((row) => row?.value ?? 0))
}

function upsertReconcile(
  tx: Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0],
  indexSpaceId: IndexSpaceID,
  projectionKind: ProjectionKind,
  eventSeq: number,
  now: number,
) {
  return tx
    .insert(ProjectionDirtyPathTable)
    .values({
      index_space_id: indexSpaceId,
      projection_kind: projectionKind,
      path: ReconcilePath,
      latest_event_seq: eventSeq,
      change_kind: "reconcile",
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [
        ProjectionDirtyPathTable.index_space_id,
        ProjectionDirtyPathTable.projection_kind,
        ProjectionDirtyPathTable.path,
      ],
      set: { latest_event_seq: eventSeq, change_kind: "reconcile", updated_at: now },
    })
    .run()
}

function event(row: typeof ChangeEventTable.$inferSelect): Event {
  return {
    eventSeq: row.event_seq,
    indexSpaceId: row.index_space_id as IndexSpaceID,
    path: row.path,
    ...(row.previous_path === null ? {} : { previousPath: row.previous_path }),
    ...(row.rename_correlation_id === null ? {} : { renameCorrelationId: row.rename_correlation_id }),
    changeKind: row.change_kind,
    ...(row.observed_mtime_ns === null ? {} : { observedMtimeNs: row.observed_mtime_ns }),
    ...(row.observed_sha === null ? {} : { observedSha: row.observed_sha }),
    source: row.source,
    observedAt: row.observed_at,
  }
}

function dirtyPath(row: typeof ProjectionDirtyPathTable.$inferSelect): DirtyPath {
  return {
    path: row.path,
    latestEventSeq: row.latest_event_seq,
    ...(row.previous_path === null ? {} : { previousPath: row.previous_path }),
    ...(row.rename_correlation_id === null ? {} : { renameCorrelationId: row.rename_correlation_id }),
    changeKind: row.change_kind,
    ...(row.observed_mtime_ns === null ? {} : { observedMtimeNs: row.observed_mtime_ns }),
    ...(row.observed_sha === null ? {} : { observedSha: row.observed_sha }),
  }
}

function registration(row: typeof ProjectionRegistrationTable.$inferSelect): Registration {
  return {
    indexSpaceId: row.index_space_id as IndexSpaceID,
    projectionKind: row.projection_kind,
    registrationEpoch: row.registration_epoch,
    state: row.state,
    consumedEventSeq: row.consumed_event_seq,
    reconcileRequired: row.reconcile_required,
    updatedAt: row.updated_at,
  }
}

function preserveErrors<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Error, R> {
  return effect.pipe(Effect.catch((error) => isError(error) ? Effect.fail(error) : Effect.die(error)))
}

function isError(value: unknown): value is Error {
  if (!value || typeof value !== "object" || !("_tag" in value)) return false
  return ["LocationChangeJournal.InvalidChangeError", "LocationChangeJournal.RegistrationError"].includes(String(value._tag))
}
