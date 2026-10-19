export * as GoalControl from "./goal-control"

import { and, desc, eq, ne, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { randomUUID } from "node:crypto"
import path from "node:path"
import type { Database } from "../database/database"
import { SessionTable } from "../session/sql"
import { SessionSchema } from "../session/schema"
import { WorkSessionGuard } from "../session/work-session-guard"
import { Hash } from "../util/hash"
import { GoalControlSchema } from "./goal-control.schema"
import { GoalTickProgram } from "./goal-tick-program"
import { GoalPlanRebase } from "./goal-plan-rebase"
import { GoalTickState } from "./goal-tick-state"
import { GoalChild } from "./goal-child"
import { GoalChildResult } from "./goal-child-result"
import { GoalControlCommandTable, GoalControlTable, GoalTickPermitTable } from "./goal-control.sql"

type Db = Database.Interface["db"]
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Reader = Db | Transaction
export type Row = typeof GoalControlTable.$inferSelect
export type Command = typeof GoalControlCommandTable.$inferSelect
export type Permit = typeof GoalTickPermitTable.$inferSelect
export const ownerID = randomUUID()

export function fingerprint(input: unknown): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter((entry) => entry[1] !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : value
  return Hash.sha256(JSON.stringify(canonical(input)))
}

const failure = (code: GoalControlSchema.Error["code"], message: string) =>
  new GoalControlSchema.Error({ code, message })
const storage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catch((error) =>
      Effect.fail(
        error instanceof GoalControlSchema.Error
          ? error
          : failure("unavailable", "Goal control storage is unavailable"),
      ),
    ),
    Effect.catchDefect(() => Effect.fail(failure("unavailable", "Goal control storage record is unreadable"))),
  )

// A Goal's model, context and validation subprocesses are ordinary execution. A scheduling permit
// cannot widen a bound Work profile or its real Session descendants into this execution lane.
export const requireOrdinary = (db: Reader, sessionID: string) =>
  storage(
    WorkSessionGuard.requireOrdinary(db, sessionID).pipe(
      Effect.andThen(GoalChild.requireOrdinary(db, sessionID)),
      Effect.mapError(() =>
        failure(
          "unsupported",
          "Bound Work, managed Goal children and their descendants cannot start or execute an ordinary Goal",
        ),
      ),
    ),
  )

export const get = (db: Reader, goalId: string) =>
  storage(
    db
      .select()
      .from(GoalControlTable)
      .where(eq(GoalControlTable.goal_id, goalId))
      .get()
      .pipe(Effect.flatMap(validateRow)),
  )
export const current = (db: Reader, sessionID: string) =>
  storage(
    db
      .select()
      .from(GoalControlTable)
      .where(and(eq(GoalControlTable.session_id, sessionID), eq(GoalControlTable.is_current, true)))
      .get()
      .pipe(Effect.flatMap(validateRow)),
  )
export const command = (db: Reader, sessionID: string, requestID: string) =>
  storage(
    db
      .select()
      .from(GoalControlCommandTable)
      .where(and(eq(GoalControlCommandTable.session_id, sessionID), eq(GoalControlCommandTable.request_id, requestID)))
      .get()
      .pipe(
        Effect.flatMap((row) =>
          row?.receipt ? decode(GoalControlSchema.Snapshot, row.receipt).pipe(Effect.as(row)) : Effect.succeed(row),
        ),
      ),
  )
const permits = (db: Reader, goalId: string) =>
  db
    .select()
    .from(GoalTickPermitTable)
    .where(and(eq(GoalTickPermitTable.goal_id, goalId), ne(GoalTickPermitTable.state, "settled")))
    .all()
    .pipe(Effect.tap((rows) => Effect.forEach(rows, validatePermit)))

const decode = <A>(schema: Schema.Decoder<A>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => failure("recovery_required", "Goal durable record failed schema validation")),
  )
export function initializationHash(
  row: Pick<
    Row,
    | "goal_id"
    | "session_id"
    | "plan_doc_id"
    | "project_id"
    | "directory"
    | "workspace_id"
    | "driver_mode"
    | "initialization"
  >,
) {
  return fingerprint({
    goalID: row.goal_id,
    sessionID: row.session_id,
    planDocId: row.plan_doc_id,
    projectID: row.project_id,
    directory: row.directory,
    workspaceID: row.workspace_id,
    driverMode: row.driver_mode,
    initialization: row.initialization,
  })
}

function initializationError(input: GoalControlSchema.Initialization) {
  if ((input.executionContract === undefined) !== (input.ownedPreparation === undefined))
    return failure("invalid_request", "Owned execution contract and preparation must be present together")
  if (!input.ownedPreparation) return
  if (
    Buffer.byteLength(JSON.stringify(input)) > 262144 ||
    new Set(input.ownedPreparation.documents.map((item) => item.documentID)).size !==
      input.ownedPreparation.documents.length
  )
    return failure("invalid_request", "Owned initialization exceeds its bounded exact document set")
  const documents = input.ownedPreparation.documents.map((item) => ({
    item,
    decoded: Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(item.payload),
  }))
  if (
    documents.some(
      ({ item, decoded }) =>
        item.state !== "pending" ||
        item.observedVersion !== null ||
        item.observedHash !== null ||
        (item.expectedVersion === null) !== (item.expectedHash === null) ||
        (item.expectedVersion !== null && item.expectedVersion < 1) ||
        item.payloadHash !== GoalTickProgram.hash(item.payload) ||
        Option.isNone(decoded) ||
        typeof decoded.value !== "object" ||
        decoded.value === null ||
        Reflect.get(decoded.value, "id") !== item.documentID,
    )
  )
    return failure("invalid_request", "Owned initial document bytes are inconsistent")
  const plan = documents.find(({ item }) => item.documentID === input.spec.planDocId)
  if (!plan || Option.isNone(plan.decoded) || typeof plan.decoded.value !== "object" || plan.decoded.value === null)
    return failure("invalid_request", "Owned preparation has no exact plan")
  const body = Reflect.get(plan.decoded.value, "body")
  if (
    typeof body !== "string" ||
    Buffer.byteLength(body) > 65536 ||
    Buffer.byteLength(plan.item.payload) > 131072 ||
    Hash.sha256(body) !== input.planHash ||
    Reflect.get(plan.decoded.value, "version") !== input.planVersion
  )
    return failure("invalid_request", "Owned initial plan differs from its frozen bytes")
}

const validateRow = Effect.fn("GoalControl.validateRow")(function* (row: Row | undefined) {
  if (!row) return undefined
  yield* decode(GoalControlSchema.Initialization, row.initialization)
  const invalid = initializationError(row.initialization)
  if (invalid) return yield* invalid
  yield* decode(GoalControlSchema.Phase, row.requested_phase)
  if (row.initialization.spec.planDocId !== row.plan_doc_id)
    return yield* failure("recovery_required", "Goal initialization plan target changed")
  if (initializationHash(row) !== row.initialization_hash)
    return yield* failure("recovery_required", "Goal immutable initialization fingerprint changed")
  return row
})
const validatePermit = Effect.fn("GoalControl.validatePermit")(function* (row: Permit) {
  yield* decode(GoalControlSchema.ChildSessions, row.child_sessions)
  yield* decode(GoalControlSchema.Outcome, row.outcome)
  if (row.state === "settled" && (row.next_seq === null || row.next_plan_version === null || row.outcome === null))
    return yield* failure("recovery_required", "Settled tick is missing its evidence")
  return row
})

/** Placement is read from the native Session row, never from command payload or cwd. */
export const session = Effect.fn("GoalControl.session")(function* (db: Reader, sessionID: string) {
  if (path.basename(sessionID) !== sessionID || [".", ".."].includes(sessionID) || sessionID.includes("\\"))
    return yield* failure("invalid_request", "Goal Session identity is not a safe storage segment")
  const row = yield* storage(
    db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, SessionSchema.ID.make(sessionID)))
      .get(),
  )
  if (!row) return yield* failure("not_found", "Goal Session does not exist")
  if (!row.v2_authority || !row.directory || !path.isAbsolute(row.directory))
    return yield* failure("unsupported", "Goal requires a native Session with trusted absolute placement")
  return row
})

export const requireTarget = Effect.fn("GoalControl.requireTarget")(function* (
  db: Reader,
  goalId: string,
  sessionID: string,
) {
  const row = yield* get(db, goalId)
  if (!row || row.session_id !== sessionID) return yield* failure("not_found", "Goal does not belong to this Session")
  if (!row.is_current) return yield* failure("target_conflict", "A different Goal is current")
  const source = yield* session(db, sessionID)
  if (
    source.directory !== row.directory ||
    source.project_id !== row.project_id ||
    source.workspace_id !== row.workspace_id
  )
    return yield* failure("target_conflict", "Goal Session placement changed")
  return row
})

export const snapshot = Effect.fn("GoalControl.snapshot")(function* (db: Reader, row: Row) {
  yield* requireTarget(db, row.goal_id, row.session_id)
  const active = yield* storage(permits(db, row.goal_id))
  const pending = yield* storage(
    db
      .select()
      .from(GoalControlCommandTable)
      .where(and(eq(GoalControlCommandTable.goal_id, row.goal_id), eq(GoalControlCommandTable.revision, row.revision)))
      .get(),
  )
  if (pending?.receipt) yield* decode(GoalControlSchema.Snapshot, pending.receipt)
  const recoveryRequired =
    !!row.recovery_reason ||
    row.preparation === "recovery_required" ||
    active.some((item) => item.state === "unknown" || item.owner_id !== ownerID)
  return {
    goalId: row.goal_id,
    planDocId: row.plan_doc_id,
    phase: row.preparation === "preparing" ? "preparing" : row.requested_phase,
    running: row.preparation === "ready" && row.requested_phase === "running" && !recoveryRequired,
    revision: row.revision,
    requestedPhase: row.requested_phase,
    preparation: row.preparation,
    inFlight: active.length > 0,
    recoveryRequired,
    wakeState: pending?.wake_state ?? "none",
    replayed: false,
  } satisfies GoalControlSchema.Snapshot
})

export const reserveStart = Effect.fn("GoalControl.reserveStart")(function* (
  db: Db,
  input: {
    sessionID: string
    requestID: string
    requestHash: string
    planDocId: string
    initialization: GoalControlSchema.Initialization
    driverMode: GoalControlSchema.Mode
  },
) {
  return yield* storage(
    db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const prior = yield* command(tx, input.sessionID, input.requestID)
          if (prior) {
            if (prior.request_hash !== input.requestHash || prior.action !== "start")
              return yield* failure("request_conflict", "Goal start requestID was reused")
            const row = yield* get(tx, prior.goal_id)
            if (!row) return yield* failure("recovery_required", "Goal preparation record is missing")
            return { row, command: prior, replayed: true }
          }
          if (!input.requestID) return yield* failure("invalid_request", "Goal start requires requestID")
          if (input.driverMode !== "event")
            return yield* failure("unsupported", "Durable resident Goal control is not available yet")
          const source = yield* session(tx, input.sessionID)
          const old = yield* current(tx, input.sessionID)
          if (old && (!isTerminal(old.requested_phase) || (yield* permits(tx, old.goal_id)).length > 0))
            return yield* failure("busy", "The Session already has an active or unresolved Goal")
          if (old)
            yield* tx
              .update(GoalControlTable)
              .set({ is_current: false })
              .where(eq(GoalControlTable.goal_id, old.goal_id))
              .run()
          const now = Date.now()
          const goalId = `goal_${fingerprint([input.sessionID, input.requestID]).slice(0, 40)}`
          yield* decode(GoalControlSchema.Initialization, input.initialization)
          const invalid = initializationError(input.initialization)
          if (invalid) return yield* invalid
          const row = yield* tx
            .insert(GoalControlTable)
            .values({
              goal_id: goalId,
              session_id: input.sessionID,
              is_current: true,
              plan_doc_id: input.planDocId,
              project_id: source.project_id,
              directory: source.directory,
              workspace_id: source.workspace_id,
              driver_mode: input.driverMode,
              initialization: input.initialization,
              preparation: "preparing",
              initialization_hash: initializationHash({
                goal_id: goalId,
                session_id: input.sessionID,
                plan_doc_id: input.planDocId,
                project_id: source.project_id,
                directory: source.directory,
                workspace_id: source.workspace_id,
                driver_mode: input.driverMode,
                initialization: input.initialization,
              }),
              revision: 0,
              requested_phase: "running",
              next_seq: 0,
              plan_version: input.initialization.planVersion,
              created_at: now,
              updated_at: now,
            })
            .returning()
            .get()
          const cmd = yield* tx
            .insert(GoalControlCommandTable)
            .values({
              command_id: `goalcmd_${fingerprint([input.sessionID, input.requestID])}`,
              session_id: input.sessionID,
              goal_id: goalId,
              request_id: input.requestID,
              request_hash: input.requestHash,
              action: "start",
              revision: 1,
              wake_state: "none",
              wake_key: `goal:control:${goalId}:1`,
              tick_seq: 0,
              plan_version: input.initialization.planVersion,
              publish_attempts: 0,
              created_at: now,
              updated_at: now,
            })
            .returning()
            .get()
          if (!row || !cmd) return yield* failure("unavailable", "Goal preparation did not return its records")
          return { row, command: cmd, replayed: false }
        }),
      { behavior: "immediate" },
    ),
  )
})

export const activate = Effect.fn("GoalControl.activate")(function* (
  db: Db,
  input: { sessionID: string; goalId: string; requestID: string; requestHash: string },
) {
  return yield* storage(
    db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const cmd = yield* command(tx, input.sessionID, input.requestID)
          if (!cmd || cmd.goal_id !== input.goalId || cmd.request_hash !== input.requestHash)
            return yield* failure("request_conflict", "Goal initialization request changed")
          if (cmd.receipt) return { ...cmd.receipt, replayed: true }
          const before = yield* requireTarget(tx, input.goalId, input.sessionID)
          if (before.preparation !== "preparing" || before.revision !== 0)
            return yield* failure("recovery_required", "Goal initialization cannot be activated")
          const row = yield* tx
            .update(GoalControlTable)
            .set({ preparation: "ready", revision: 1, updated_at: Date.now() })
            .where(eq(GoalControlTable.goal_id, input.goalId))
            .returning()
            .get()
          if (!row) return yield* failure("unavailable", "Goal activation failed")
          const receipt: GoalControlSchema.Snapshot = {
            ...(yield* snapshot(tx, row)),
            wakeState: "pending",
            receiptID: cmd.command_id,
            replayed: false,
          }
          yield* tx
            .update(GoalControlCommandTable)
            .set({ receipt, wake_state: "pending", updated_at: Date.now() })
            .where(eq(GoalControlCommandTable.command_id, cmd.command_id))
            .run()
          return receipt
        }),
      { behavior: "immediate" },
    ),
  )
})

export const control = Effect.fn("GoalControl.control")(function* (
  db: Db,
  input: GoalControlSchema.ControlInput & { action: GoalControlSchema.Action },
) {
  return yield* storage(
    db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const hash = fingerprint(input)
          const prior = yield* command(tx, input.sessionID, input.requestID)
          if (prior) {
            if (prior.request_hash !== hash || !prior.receipt)
              return yield* failure("request_conflict", "Goal command requestID was reused")
            return { ...prior.receipt, replayed: true }
          }
          const row = yield* requireTarget(tx, input.goalId, input.sessionID)
          if (!input.requestID || !Number.isSafeInteger(input.expectedRevision))
            return yield* failure("invalid_request", "Goal control requires a requestID and exact revision")
          if (row.revision !== input.expectedRevision)
            return yield* failure("revision_conflict", "Goal control revision changed")
          if (row.preparation !== "ready" || row.driver_mode !== "event")
            return yield* failure("unsupported", "Goal is not ready for durable control")
          const active = yield* permits(tx, row.goal_id)
          if (isTerminal(row.requested_phase))
            return yield* failure("target_conflict", "Terminal Goals cannot be reopened or controlled")
          if (row.pending_rebase_id && input.action === "resume")
            return yield* failure("busy", "Goal plan edit must settle or cancel before ordinary control")
          if (input.action === "resume" && (row.recovery_reason || active.length))
            return yield* failure("recovery_required", "Goal has an unresolved tick; resume cannot replay it")
          if (input.action === "resume" && row.requested_phase !== "paused")
            return yield* failure("target_conflict", "Only a paused Goal can resume")
          if (input.action === "resume" && (row.plan_revision > 0 || row.initialization.executionContract === "owned-goal-v2")) {
            const source = yield* GoalPlanRebase.baseline(tx, row)
            const document = source.documents.find((item) => item.id === `doc:run_context:${row.goal_id}`)
            const runtime = document ? yield* decode(Schema.fromJsonString(GoalTickState.Runtime), document.body) : undefined
            if (!runtime || !GoalTickState.remainingBudget(runtime))
              return yield* failure("target_conflict", "Rebased Goal has no remaining original execution budget")
          }
          const phase = input.action === "resume" ? "running" : input.action === "pause" ? "paused" : "stopped"
          const revision = row.revision + 1
          const controlled = yield* tx
            .update(GoalControlTable)
            .set({ requested_phase: phase, revision, updated_at: Date.now() })
            .where(eq(GoalControlTable.goal_id, row.goal_id))
            .returning()
            .get()
          if (!controlled) return yield* failure("unavailable", "Goal control did not update")
          const updated = input.action === "resume" ? controlled : yield* GoalPlanRebase.onControl(tx, controlled, input.action, input.requestID).pipe(
            Effect.mapError((error) => failure("recovery_required", error.message)),
          )
          yield* tx
            .update(GoalControlCommandTable)
            .set({ wake_state: "superseded" })
            .where(
              and(eq(GoalControlCommandTable.goal_id, row.goal_id), eq(GoalControlCommandTable.wake_state, "pending")),
            )
            .run()
          if (input.action === "stop")
            yield* tx
              .update(GoalTickPermitTable)
              .set({ interrupt_state: "requested" })
              .where(and(eq(GoalTickPermitTable.goal_id, row.goal_id), ne(GoalTickPermitTable.state, "settled")))
              .run()
          const commandID = `goalcmd_${fingerprint([input.sessionID, input.requestID])}`
          const receipt: GoalControlSchema.Snapshot = {
            ...(yield* snapshot(tx, updated)),
            receiptID: commandID,
            wakeState: input.action === "resume" ? "pending" : "none",
          }
          yield* tx
            .insert(GoalControlCommandTable)
            .values({
              command_id: commandID,
              session_id: row.session_id,
              goal_id: row.goal_id,
              request_id: input.requestID,
              request_hash: hash,
              action: input.action,
              revision,
              receipt,
              wake_state: receipt.wakeState,
              wake_key: `goal:control:${row.goal_id}:${revision}`,
              tick_seq: row.next_seq,
              plan_version: row.plan_version,
              publish_attempts: 0,
              created_at: Date.now(),
              updated_at: Date.now(),
            })
            .run()
          return receipt
        }),
      { behavior: "immediate" },
    ).pipe((effect) => input.action === "resume" ? effect.pipe(GoalChildResult.withRuntimeIdentity(db)) : effect),
  )
})

export const beginTick = Effect.fn("GoalControl.beginTick")(function* (
  db: Db,
  input: GoalControlSchema.Tick & { mode: GoalControlSchema.Mode },
) {
  return yield* storage(
    db.transaction(
      (tx) =>
        Effect.gen(function* () {
          yield* requireOrdinary(tx, input.sessionID)
          const row = yield* requireTarget(tx, input.goalId, input.sessionID)
          if (row.preparation !== "ready" || row.driver_mode !== input.mode || row.plan_doc_id !== input.planDocId)
            return yield* failure("unsupported", "Goal driver or initialization does not match")
          if (row.revision !== input.revision || row.requested_phase !== "running")
            return yield* failure("revision_conflict", "Goal tick was superseded by control")
          const prior = yield* tx
            .select()
            .from(GoalTickPermitTable)
            .where(and(eq(GoalTickPermitTable.goal_id, row.goal_id), eq(GoalTickPermitTable.tick_seq, input.seq)))
            .get()
          if (prior) yield* validatePermit(prior)
          if (prior?.state === "settled") {
            if (prior.plan_version !== input.expectedPlanVersion)
              return yield* failure("target_conflict", "Settled tick plan cursor does not match")
            return { row, permit: prior, replayed: true }
          }
          if (row.pending_rebase_id) return yield* failure("busy", "Goal plan edit fences the next tick")
          if (prior || row.recovery_reason || (yield* permits(tx, row.goal_id)).length)
            return yield* failure("recovery_required", "An issued tick cannot be replayed, including after owner loss")
          if (row.next_seq !== input.seq || row.plan_version !== input.expectedPlanVersion)
            return yield* failure("target_conflict", "Goal cursor does not match its durable permit boundary")
          const last = yield* tx
            .select()
            .from(GoalTickPermitTable)
            .where(and(eq(GoalTickPermitTable.goal_id, row.goal_id), eq(GoalTickPermitTable.state, "settled")))
            .orderBy(desc(GoalTickPermitTable.tick_seq))
            .get()
          if (last) yield* validatePermit(last)
          if (row.initialization.executionContract === "owned-goal-v2" && row.plan_revision > 0)
            yield* GoalPlanRebase.baseline(tx, row).pipe(Effect.mapError(() => failure("recovery_required", "Goal structural lineage has no committed source")))
          if (
            row.next_seq !== (last?.next_seq ?? 0) ||
            (row.plan_revision === 0 && row.plan_version !== (last?.next_plan_version ?? row.initialization.planVersion))
          )
            return yield* failure("recovery_required", "Goal cursor has no matching committed evidence")
          const permit = yield* tx
            .insert(GoalTickPermitTable)
            .values({
              permit_id: `goaltick_${fingerprint([row.goal_id, input.seq])}`,
              goal_id: row.goal_id,
              tick_seq: input.seq,
              control_revision: input.revision,
              plan_version: input.expectedPlanVersion,
              owner_id: ownerID,
              token: randomUUID(),
              state: "issued",
              child_sessions: [],
              interrupt_state: "none",
              created_at: Date.now(),
            })
            .returning()
            .get()
          if (!permit) return yield* failure("unavailable", "Goal tick permit was not committed")
          return { row, permit, replayed: false }
        }),
      { behavior: "immediate" },
    ),
  )
})

export const settleTick = Effect.fn("GoalControl.settleTick")(function* (
  db: Db,
  input: { permit: Permit; nextSeq: number; planVersion: number; phase: string },
) {
  return yield* storage(
    db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const permit = yield* tx
            .select()
            .from(GoalTickPermitTable)
            .where(eq(GoalTickPermitTable.permit_id, input.permit.permit_id))
            .get()
          if (!permit || permit.token !== input.permit.token || permit.state !== "issued")
            return yield* failure("recovery_required", "Goal tick settlement lost its exact permit")
          yield* validatePermit(permit)
          const existing = yield* get(tx, permit.goal_id)
          const row = existing ? yield* requireTarget(tx, permit.goal_id, existing.session_id) : undefined
          if (!row) return yield* failure("not_found", "Goal settlement target disappeared")
          if (input.nextSeq <= permit.tick_seq && input.phase === "running")
            return yield* failure("recovery_required", "Goal tick did not prove cursor advancement")
          yield* tx
            .update(GoalTickPermitTable)
            .set({
              state: "settled",
              next_seq: input.nextSeq,
              next_plan_version: input.planVersion,
              outcome: input.phase,
              settled_at: Date.now(),
            })
            .where(eq(GoalTickPermitTable.permit_id, permit.permit_id))
            .run()
          const phase =
            isTerminal(input.phase) && row.revision === permit.control_revision && row.requested_phase === "running"
              ? (input.phase as GoalControlSchema.Phase)
              : row.requested_phase
          yield* tx
            .update(GoalControlTable)
            .set({
              next_seq: input.nextSeq,
              plan_version: input.planVersion,
              observed_phase: input.phase,
              requested_phase: phase,
              updated_at: Date.now(),
            })
            .where(eq(GoalControlTable.goal_id, row.goal_id))
            .run()
        }),
      { behavior: "immediate" },
    ),
  )
})

export const unknown = (db: Db, permit: Permit) =>
  storage(
    db
      .update(GoalTickPermitTable)
      .set({ state: "unknown" })
      .where(
        and(
          eq(GoalTickPermitTable.permit_id, permit.permit_id),
          eq(GoalTickPermitTable.token, permit.token),
          eq(GoalTickPermitTable.state, "issued"),
        ),
      )
      .run(),
  )
export const pendingWakes = (db: Db) =>
  storage(
    db
      .select()
      .from(GoalControlCommandTable)
      .where(eq(GoalControlCommandTable.wake_state, "pending"))
      .orderBy(GoalControlCommandTable.created_at)
      .limit(32)
      .all()
      .pipe(Effect.tap((rows) => Effect.forEach(rows, (row) => decode(GoalControlSchema.Snapshot, row.receipt)))),
  )
export const wakeEligible = Effect.fn("GoalControl.wakeEligible")(function* (db: Db, cmd: Command) {
  const row = yield* requireTarget(db, cmd.goal_id, cmd.session_id)
  return !row.pending_rebase_id && ["start", "resume"].includes(cmd.action) && row.preparation === "ready" &&
    row.requested_phase === "running" &&
    row.revision === cmd.revision &&
    row.driver_mode === "event"
    ? row
    : undefined
})
export const markWake = (db: Db, cmd: Command, state: GoalControlSchema.WakeState, error?: string) =>
  storage(
    db
      .update(GoalControlCommandTable)
      .set({
        wake_state: state,
        publish_attempts: sql`${GoalControlCommandTable.publish_attempts} + 1`,
        last_error: error ?? null,
        updated_at: Date.now(),
      })
      .where(
        and(eq(GoalControlCommandTable.command_id, cmd.command_id), eq(GoalControlCommandTable.wake_state, "pending")),
      )
      .run(),
  )
export function isTerminal(phase: string) {
  return ["stopped", "done", "needs_human", "rolled_back"].includes(phase)
}
