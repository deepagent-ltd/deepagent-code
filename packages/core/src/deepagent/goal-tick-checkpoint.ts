export * as GoalTickCheckpoint from "./goal-tick-checkpoint"

import { and, asc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm"
import { Cause, Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { EventTable, EventSequenceTable } from "../event/sql"
import { SessionEvent } from "../session/event"
import { SessionSchema } from "../session/schema"
import { SessionMessage } from "../session/message"
import { SessionTable, SessionSteerTable } from "../session/sql"
import { fromRow } from "../session/info"
import { GoalControl } from "./goal-control"
import { GoalControlSchema } from "./goal-control.schema"
import { GoalTickPermitTable } from "./goal-control.sql"
import { GoalTickCheckpointSchema } from "./goal-tick-checkpoint.schema"
import { GoalTickCheckpointTable } from "./goal-tick-checkpoint.sql"
import { GoalChildResult } from "./goal-child-result"
import { GoalChild } from "./goal-child"
import { GoalChildUnitTable } from "./goal-child.sql"
import { DocumentStore } from "./document-store"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"

type Db = Database.Interface["db"]
export type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0]
export type Reader = Db | Transaction
export type Row = Omit<typeof GoalTickCheckpointTable.$inferSelect, "journal"> & {
  readonly journal: GoalTickCheckpointSchema.Journal
}
const fail = (code: GoalTickCheckpointSchema.Error["code"], message: string) =>
  new GoalTickCheckpointSchema.Error({ code, message })
export function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(normalize)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .filter((entry) => entry[1] !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, value]) => [key, normalize(value)]),
          )
        : item
  return JSON.stringify(normalize(value))
}
export function authority(row: typeof SessionTable.$inferSelect) {
  const info = fromRow(row)
  return {
    id: info.id,
    parentID: info.parentID,
    projectID: info.projectID,
    location: info.location,
    agent: info.agent,
    model: info.model,
    permissions: info.permissions,
    metadata: info.metadata,
    mutationEpoch: row.mutation_epoch,
    archived: row.time_archived,
  }
}
export const permitAuthority = (db: Reader, permitID: string, token?: string, execution = true) =>
  Effect.gen(function* () {
    const permit = yield* db
      .select()
      .from(GoalTickPermitTable)
      .where(eq(GoalTickPermitTable.permit_id, permitID))
      .get()
      .pipe(Effect.orDie)
    if (
      !permit ||
      (token !== undefined && permit.token !== token) ||
      permit.state !== "issued" ||
      (execution && permit.owner_id !== GoalControl.ownerID)
    )
      return yield* fail("CHECKPOINT_CONTROL_CHANGED", "Tick has no current issued permit")
    const goal = yield* GoalControl.get(db, permit.goal_id)
    if (
      !goal?.is_current ||
      goal.preparation !== "ready" ||
      goal.requested_phase !== "running" ||
      goal.revision !== permit.control_revision ||
      goal.next_seq !== permit.tick_seq ||
      goal.plan_version !== permit.plan_version
    )
      return yield* fail("CHECKPOINT_CONTROL_CHANGED", "Goal control changed")
    return { permit, goal }
  })

export const currentPermit = (db: Reader, permitID: string, token?: string) => permitAuthority(db, permitID, token)

const permitBinding = (permit: typeof GoalTickPermitTable.$inferSelect) => ({
  id: permit.permit_id,
  token: permit.token,
  goalID: permit.goal_id,
  tickSeq: permit.tick_seq,
  controlRevision: permit.control_revision,
  planVersion: permit.plan_version,
  ownerID: permit.owner_id,
})

export const read = (db: Reader, permitID: string) =>
  Effect.gen(function* () {
    const row = yield* db
      .select()
      .from(GoalTickCheckpointTable)
      .where(eq(GoalTickCheckpointTable.permit_id, permitID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return undefined
    if (row.version !== 1)
      return yield* fail(
        "CHECKPOINT_INVALID",
        "Version 1 checkpoint operation cannot interpret another journal version",
      )
    const decoded = Schema.decodeUnknownOption(GoalTickCheckpointSchema.Journal, { onExcessProperty: "error" })(
      row.journal,
    )
    if (Option.isNone(decoded)) return yield* fail("CHECKPOINT_INVALID", "Version 1 checkpoint journal is malformed")
    const journal = decoded.value
    yield* validate(journal)
    const goal = yield* GoalControl.get(db, row.goal_id)
    const permit = yield* db
      .select()
      .from(GoalTickPermitTable)
      .where(eq(GoalTickPermitTable.permit_id, row.permit_id))
      .get()
      .pipe(Effect.orDie)
    if (
      !goal ||
      !permit ||
      permit.goal_id !== row.goal_id ||
      permit.tick_seq !== row.tick_seq ||
      goal.session_id !== journal.parent.sessionID ||
      row.binding_hash !==
        GoalControl.fingerprint({
          parent: journal.parent,
          roles: journal.roles,
          budgets: journal.budgets,
          permit: permitBinding(permit),
          initializationHash: goal.initialization_hash,
        })
    )
      return yield* fail("CHECKPOINT_RECOVERY_REQUIRED", "Checkpoint source binding is inconsistent")
    const cursor = yield* resultCursor(journal, row.permit_id)
    if (
      row.state !== "recovery_required" &&
      GoalControl.fingerprint(cursor) !== GoalControl.fingerprint(journal.cursor)
    )
      return yield* fail("CHECKPOINT_RECOVERY_REQUIRED", "Checkpoint cursor is not backed by its exact role receipts")
    if (
      row.version !== 1 ||
      row.journal_hash !== GoalControl.fingerprint(row.journal) ||
      row.role_manifest_hash !== GoalControl.fingerprint(journal.roles) ||
      row.logical_bytes !== Buffer.byteLength(JSON.stringify(row.journal)) ||
      row.reserved_bytes < row.logical_bytes ||
      row.parent_checked_through_seq < journal.parent.sourceSeq ||
      !Schema.is(GoalTickCheckpointSchema.State)(row.state)
    )
      return yield* fail("CHECKPOINT_RECOVERY_REQUIRED", "Checkpoint integrity does not match its durable content")
    return { ...row, journal }
  })

export const begin = (
  db: Db,
  input: {
    permitID: string
    permitToken: string
    roles: GoalTickCheckpointSchema.Journal["roles"]
    budgets: GoalTickCheckpointSchema.Journal["budgets"]
  },
) =>
  db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const source = yield* currentPermit(tx, input.permitID, input.permitToken)
        const existing = yield* read(tx, input.permitID)
        if (existing) {
          if (
            GoalControl.fingerprint([input.roles, input.budgets]) !==
            GoalControl.fingerprint([existing.journal.roles, existing.journal.budgets])
          )
            return yield* fail("CHECKPOINT_CONFLICT", "Tick manifest was already frozen differently")
          yield* requireParent(tx, existing)
          return existing
        }
        const parent = yield* GoalControl.session(tx, source.goal.session_id)
        const sequence = yield* tx
          .select()
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, parent.id))
          .get()
          .pipe(Effect.orDie)
        if (!sequence || !parent.v2_authority)
          return yield* fail("PARENT_HISTORY_UNAVAILABLE", "Native parent history is missing")
        const steers = yield* tx
          .select()
          .from(SessionSteerTable)
          .where(
            and(
              eq(SessionSteerTable.session_id, parent.id),
              eq(SessionSteerTable.delivery, "goal_steer"),
              eq(SessionSteerTable.mutation_epoch, parent.mutation_epoch),
              isNull(SessionSteerTable.consumed_seq),
              isNull(SessionSteerTable.superseded_at),
            ),
          )
          .orderBy(asc(SessionSteerTable.seq))
          .limit(257)
          .all()
          .pipe(Effect.orDie)
        if (steers.length > 256)
          return yield* fail("CHECKPOINT_CAPACITY", "Goal steering snapshot exceeds its bounded capacity")
        const journal: GoalTickCheckpointSchema.Journal = {
          version: 1,
          parent: {
            sessionID: parent.id,
            sourceSeq: sequence.seq,
            authorityHash: GoalControl.fingerprint(authority(parent)),
            authority: canonical(authority(parent)),
            steering: {
              cutoff: steers.at(-1)?.seq ?? 0,
              mutationEpoch: parent.mutation_epoch,
              rows: steers.map((row) => ({
                id: row.id,
                seq: row.seq,
                hash: GoalControl.fingerprint({
                  id: row.id,
                  prompt: row.prompt,
                  mutationEpoch: row.mutation_epoch,
                  delivery: row.delivery,
                }),
              })),
            },
          },
          roles: input.roles,
          budgets: input.budgets,
          cursor: { role: 0, stage: input.roles[0]?.mode === "structured" ? "research" : "plain" },
          results: [],
          localEffects: [],
          mirrors: [],
          nextState: null,
          nextStateHash: null,
        }
        yield* validate(journal)
        const capacity = yield* tx
          .get<{
            records: number
            bytes: number
          }>(sql`SELECT count(*) AS records,coalesce(sum(reserved_bytes),0) AS bytes FROM (SELECT reserved_bytes FROM goal_tick_checkpoint UNION ALL SELECT reserved_bytes FROM goal_pause_boundary)`)
          .pipe(Effect.orDie)
        if (
          !capacity ||
          capacity.records >= GoalTickCheckpointSchema.MAX_RECORDS ||
          capacity.bytes + GoalTickCheckpointSchema.MAX_BYTES > GoalTickCheckpointSchema.MAX_INSTANCE_BYTES
        )
          return yield* fail("CHECKPOINT_CAPACITY", "Checkpoint storage capacity is exhausted")
        const now = Date.now()
        yield* tx
          .insert(GoalTickCheckpointTable)
          .values({
            permit_id: input.permitID,
            goal_id: source.goal.goal_id,
            tick_seq: source.permit.tick_seq,
            version: 1,
            revision: 0,
            binding_hash: GoalControl.fingerprint({
              parent: journal.parent,
              roles: journal.roles,
              budgets: journal.budgets,
              permit: permitBinding(source.permit),
              initializationHash: source.goal.initialization_hash,
            }),
            role_manifest_hash: GoalControl.fingerprint(journal.roles),
            parent_checked_through_seq: sequence.seq,
            state: "prepared",
            journal,
            journal_hash: GoalControl.fingerprint(journal),
            logical_bytes: Buffer.byteLength(JSON.stringify(journal)),
            reserved_bytes: GoalTickCheckpointSchema.MAX_BYTES,
            error_code: null,
            created_at: now,
            updated_at: now,
          })
          .run()
          .pipe(Effect.orDie)
        return (yield* read(tx, input.permitID))!
      }),
    { behavior: "immediate" },
  )

export const requireParent = (db: Reader, row: Row) =>
  currentPermit(db, row.permit_id).pipe(Effect.flatMap(() => requireParentFacts(db, row)))

const requireProjection = (db: Reader, row: Row) =>
  Effect.gen(function* () {
    if (
      row.state !== "mirror_pending" ||
      row.journal.cursor.role !== row.journal.roles.length ||
      row.journal.localEffects.some((effect) => ["prepared", "dispatched", "unknown"].includes(effect.state))
    )
      return yield* fail("CHECKPOINT_RECOVERY_REQUIRED", "Projection requires all actual work to be settled")
    const source = yield* permitAuthority(db, row.permit_id, undefined, false)
    yield* GoalChildResult.inspectMany(db, row.journal.results)
    yield* requireParentFacts(db, row)
    return source
  })

export type ParentFactsRow = Pick<Row, "permit_id" | "revision" | "state" | "parent_checked_through_seq"> & {
  readonly journal: { readonly parent: GoalTickCheckpointSchema.Parent }
}

/** Shared semantic frontier check. The versioned caller must first validate its whole journal. */
export const requireParentFacts = (db: Reader, row: ParentFactsRow) =>
  Effect.gen(function* () {
    if (!["prepared", "running", "mirror_pending"].includes(row.state))
      return yield* fail("CHECKPOINT_RECOVERY_REQUIRED", "Checkpoint no longer permits execution")
    return yield* requireParentSourceFacts(db, row)
  })

/** Historical source inspection only. It grants no permit, live policy, or execution authority. */
export const requireParentSourceFacts = (db: Reader, row: ParentFactsRow) =>
  Effect.gen(function* () {
    const parent = yield* GoalControl.session(db, row.journal.parent.sessionID)
    if (GoalControl.fingerprint(authority(parent)) !== row.journal.parent.authorityHash)
      return yield* fail("PARENT_AUTHORITY_CHANGED", "Parent authority differs from the frozen tick")
    const sequence = yield* db
      .select()
      .from(EventSequenceTable)
      .where(eq(EventSequenceTable.aggregate_id, parent.id))
      .get()
      .pipe(Effect.orDie)
    if (
      !sequence ||
      sequence.seq < row.parent_checked_through_seq ||
      (sequence.retention_floor_seq ?? -1) > row.parent_checked_through_seq + 1
    )
      return yield* fail("PARENT_HISTORY_UNAVAILABLE", "Parent event frontier cannot be proven")
    if (sequence.seq - row.parent_checked_through_seq > 4096)
      return yield* fail("PARENT_FRONTIER_LIMIT", "Parent event gap exceeds its bounded inspection limit")
    let cursor = row.parent_checked_through_seq
    let bytes = 0
    while (cursor < sequence.seq) {
      const events = yield* db
        .select()
        .from(EventTable)
        .where(
          and(eq(EventTable.aggregate_id, parent.id), gt(EventTable.seq, cursor), lte(EventTable.seq, sequence.seq)),
        )
        .orderBy(asc(EventTable.seq))
        .limit(128)
        .all()
        .pipe(Effect.orDie)
      if (events.length === 0) return yield* fail("PARENT_HISTORY_UNAVAILABLE", "Parent event gap has missing entries")
      for (const event of events) {
        if (event.seq !== cursor + 1)
          return yield* fail("PARENT_HISTORY_UNAVAILABLE", "Parent event gap is not contiguous")
        bytes += Buffer.byteLength(JSON.stringify(event.data))
        if (bytes > 8_388_608)
          return yield* fail("PARENT_FRONTIER_LIMIT", "Parent event bytes exceed inspection capacity")
        yield* requireNeutral(event, row.journal.parent)
        cursor = event.seq
      }
    }
    // A new steering row is deliberately not included; only frozen IDs are checked and later consumed.
    for (const frozen of row.journal.parent.steering.rows) {
      const steer = yield* db
        .select()
        .from(SessionSteerTable)
        .where(eq(SessionSteerTable.id, SessionMessage.ID.make(frozen.id)))
        .get()
        .pipe(Effect.orDie)
      if (
        !steer ||
        steer.session_id !== parent.id ||
        steer.seq !== frozen.seq ||
        steer.consumed_seq !== null ||
        steer.superseded_at !== null ||
        GoalControl.fingerprint({
          id: steer.id,
          prompt: steer.prompt,
          mutationEpoch: steer.mutation_epoch,
          delivery: steer.delivery,
        }) !== frozen.hash
      )
        return yield* fail("PARENT_AUTHORITY_CHANGED", "Frozen Goal steering changed")
    }
    if (cursor !== row.parent_checked_through_seq) {
      const updated = yield* db
        .update(GoalTickCheckpointTable)
        .set({ parent_checked_through_seq: cursor })
        .where(
          and(
            eq(GoalTickCheckpointTable.permit_id, row.permit_id),
            eq(GoalTickCheckpointTable.revision, row.revision),
            eq(GoalTickCheckpointTable.parent_checked_through_seq, row.parent_checked_through_seq),
          ),
        )
        .returning({ id: GoalTickCheckpointTable.permit_id })
        .all()
        .pipe(Effect.orDie)
      if (updated.length !== 1) return yield* fail("CHECKPOINT_CONFLICT", "Parent frontier compare-and-swap lost")
    }
  })

const neutral = [
  SessionEvent.DiffUpdated,
  SessionEvent.ContextUpdated,
  SessionEvent.Synthetic,
  SessionEvent.StructuredCaptured,
  SessionEvent.PromptLifecycle.Admitted,
  SessionEvent.Execution.Started,
  SessionEvent.Execution.Succeeded,
  SessionEvent.Execution.Failed,
  SessionEvent.Execution.Interrupted,
  SessionEvent.Step.Started,
  SessionEvent.Step.Ended,
  SessionEvent.Step.Failed,
  SessionEvent.Text.Started,
  SessionEvent.Text.Ended,
  SessionEvent.Reasoning.Started,
  SessionEvent.Reasoning.Ended,
  SessionEvent.Tool.Input.Started,
  SessionEvent.Tool.Input.Ended,
  SessionEvent.Tool.Called,
  SessionEvent.Tool.Progress,
  SessionEvent.Tool.Success,
  SessionEvent.Tool.Failed,
]
const decoders = new Map<string, Schema.Decoder<unknown>>(
  neutral.map((definition) => [`${definition.type}.${definition.sync!.version}`, definition.data]),
)
function requireNeutral(event: typeof EventTable.$inferSelect, parent: GoalTickCheckpointSchema.Parent) {
  return Effect.gen(function* () {
    if (event.type === `${SessionEvent.Updated.type}.2`) {
      const decoded = Schema.decodeUnknownOption(SessionEvent.Updated.data)(event.data)
      const saved = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(parent.authority)
      if (Option.isNone(decoded) || Option.isNone(saved) || typeof saved.value !== "object" || saved.value === null)
        return yield* fail("PARENT_HISTORY_UNAVAILABLE", "Parent update could not be decoded")
      const info = decoded.value.info
      const projected = {
        ...saved.value,
        id: info.id,
        parentID: info.parentID,
        projectID: info.projectID,
        location: info.location,
        agent: info.agent,
        model: info.model,
        permissions: info.permissions,
        metadata: info.metadata,
        archived: info.time.archived ? Number(info.time.archived.epochMilliseconds) : null,
      }
      if (GoalControl.fingerprint(projected) !== parent.authorityHash)
        return yield* fail("PARENT_AUTHORITY_CHANGED", "Parent update changed tick authority")
      return
    }
    if (event.type === `${SessionEvent.PromptLifecycle.Promoted.type}.1`) {
      const decoded = Schema.decodeUnknownOption(SessionEvent.PromptLifecycle.Promoted.data)(event.data)
      if (Option.isNone(decoded))
        return yield* fail("PARENT_HISTORY_UNAVAILABLE", "Parent promotion could not be decoded")
      if (decoded.value.prompt.agent !== undefined || decoded.value.prompt.model !== undefined)
        return yield* fail("PARENT_AUTHORITY_CHANGED", "Parent promotion changed selection")
      return
    }
    const decoder = decoders.get(event.type)
    if (!decoder || Option.isNone(Schema.decodeUnknownOption(decoder)(event.data)))
      return yield* fail("PARENT_AUTHORITY_CHANGED", "Parent event is not a proven neutral version")
  })
}

export const validate = (journal: GoalTickCheckpointSchema.Journal) =>
  Effect.gen(function* () {
    if (!Schema.is(GoalTickCheckpointSchema.Journal)(journal))
      return yield* fail("CHECKPOINT_INVALID", "Checkpoint schema is invalid")
    const roleTuples = journal.roles.map((role) =>
      canonical([role.kind, role.ordinal, role.criterion, role.round, role.lens]),
    )
    if (
      new Set(roleTuples).size !== roleTuples.length ||
      journal.roles.some((role) => role.criterion !== null && role.criterion > 63)
    )
      return yield* fail("CHECKPOINT_INVALID", "Goal role semantic identities duplicate or exceed their bound")
    if (
      new Set(journal.parent.steering.rows.map((row) => row.id)).size !== journal.parent.steering.rows.length ||
      journal.parent.steering.rows.some(
        (row, index) =>
          row.seq > journal.parent.steering.cutoff ||
          (index > 0 && row.seq <= journal.parent.steering.rows[index - 1].seq),
      )
    )
      return yield* fail("CHECKPOINT_INVALID", "Frozen steering identity is inconsistent")
    const slots = journal.roles.reduce((sum, role) => sum + (role.mode === "structured" ? 3 : 1), 0)
    if (
      new Set(journal.roles.map((role) => role.key)).size !== journal.roles.length ||
      journal.roles.some(
        (role) =>
          role.ordinal > 63 ||
          (role.kind === "panel"
            ? role.criterion === null || role.round === null || role.round >= 3 || role.lens === null || role.lens >= 8
            : role.round !== null || role.lens !== null) ||
          (role.kind === "worker" && role.criterion !== null),
      ) ||
      journal.budgets.resultSlots !== slots ||
      journal.budgets.effectSlots > 33 ||
      journal.cursor.role > journal.roles.length ||
      (journal.cursor.role < journal.roles.length &&
        !(
          journal.roles[journal.cursor.role].mode === "plain" ? ["plain"] : ["research", "finalizer.1", "finalizer.2"]
        ).includes(journal.cursor.stage))
    )
      return yield* fail("CHECKPOINT_INVALID", "Role manifest, cursor or fixed result slots are inconsistent")
    if (
      new Set(journal.budgets.mirrors.map((mirror) => mirror.documentID)).size !== journal.budgets.mirrors.length ||
      journal.budgets.mirrors.some((mirror) => mirror.bytes > 262144) ||
      journal.budgets.nextStateBytes > 262144
    )
      return yield* fail("CHECKPOINT_INVALID", "Mirror storage budgets are invalid")
    const empty = { ...journal, results: [], localEffects: [], mirrors: [], nextState: null, nextStateHash: null }
    const reserved =
      Buffer.byteLength(canonical(empty)) +
      slots * GoalTickCheckpointSchema.RESULT_BYTES +
      journal.budgets.effectSlots * GoalTickCheckpointSchema.EFFECT_BYTES +
      journal.budgets.mirrors.reduce((sum, mirror) => sum + mirror.bytes + 2048, 0) +
      journal.budgets.nextStateBytes +
      512
    if (
      reserved > GoalTickCheckpointSchema.MAX_BYTES ||
      Buffer.byteLength(canonical(journal)) > GoalTickCheckpointSchema.MAX_BYTES ||
      journal.results.some((result) => Buffer.byteLength(canonical(result)) > GoalTickCheckpointSchema.RESULT_BYTES) ||
      journal.localEffects.length > journal.budgets.effectSlots ||
      journal.localEffects.some(
        (effect) => Buffer.byteLength(canonical(effect)) > GoalTickCheckpointSchema.EFFECT_BYTES,
      )
    )
      return yield* fail("CHECKPOINT_CAPACITY", "Checkpoint exceeds its independently reserved storage slots")
    if (
      journal.mirrors.some(
        (mirror) =>
          GoalControl.fingerprint(mirror.payload) !== mirror.payloadHash ||
          Buffer.byteLength(JSON.stringify(mirror.payload)) >
            (journal.budgets.mirrors.find((budget) => budget.documentID === mirror.documentID)?.bytes ?? -1),
      ) ||
      (journal.nextState !== null &&
        (Buffer.byteLength(JSON.stringify(journal.nextState)) > journal.budgets.nextStateBytes ||
          GoalControl.fingerprint(journal.nextState) !== journal.nextStateHash))
    )
      return yield* fail("CHECKPOINT_CAPACITY", "Projection payload exceeds its pre-dispatch reservation")
  })

const resultCursor = (journal: GoalTickCheckpointSchema.Journal, permitID: string) =>
  Effect.gen(function* () {
    const units = new Map(
      journal.roles.map((role) => [`goalchild_${GoalControl.fingerprint([permitID, role.key])}`, role]),
    )
    if (
      new Set(journal.results.map((result) => result.inputID)).size !== journal.results.length ||
      new Set(journal.results.map((result) => result.activityID)).size !== journal.results.length ||
      new Set(journal.results.map((result) => result.messageID)).size !== journal.results.length ||
      new Set(journal.results.map((result) => result.executionID)).size !== journal.results.length
    )
      return yield* fail("CHECKPOINT_RECOVERY_REQUIRED", "Goal stage receipts duplicate execution identities")
    for (const result of journal.results) {
      const role = units.get(result.unitID)
      if (
        !role ||
        result.inputID !== `msg_goalchild_${GoalControl.fingerprint([result.unitID, result.stage]).slice(0, 40)}` ||
        (role.mode === "plain" ? result.stage !== "plain" : result.stage === "plain") ||
        ((result.stage === "plain" || result.stage === "research") && result.outcome !== "valid")
      )
        return yield* fail("CHECKPOINT_RECOVERY_REQUIRED", "Goal result is outside its immutable role/stage identity")
    }
    const pending: GoalTickCheckpointSchema.Cursor[] = []
    for (const [index, role] of journal.roles.entries()) {
      const unitID = `goalchild_${GoalControl.fingerprint([permitID, role.key])}`
      const results = journal.results.filter((result) => result.unitID === unitID)
      if (role.mode === "plain") {
        if (results.length === 0) pending.push({ role: index, stage: "plain" })
        continue
      }
      const stages = ["research", "finalizer.1", "finalizer.2"]
      if (
        results.some((result, index) => result.stage !== stages[index]) ||
        (results.length === 3 && results[1].outcome !== "schema_invalid")
      )
        return yield* fail("CHECKPOINT_RECOVERY_REQUIRED", "Goal finalizer did not follow its known predecessor")
      if (results.length === 0) pending.push({ role: index, stage: "research" })
      if (results.length === 1) pending.push({ role: index, stage: "finalizer.1" })
      if (results.length === 2 && results[1].outcome === "schema_invalid")
        pending.push({ role: index, stage: "finalizer.2" })
    }
    return pending[0] ?? { role: journal.roles.length, stage: "plain" as const }
  })

/** Internal transactional write; callers must first prove the corresponding business transition. */
const write = (
  db: Reader,
  prior: Row,
  journal: GoalTickCheckpointSchema.Journal,
  state: GoalTickCheckpointSchema.State,
  errorCode: string | null = null,
) =>
  Effect.gen(function* () {
    yield* validate(journal)
    const stable = (value: GoalTickCheckpointSchema.Journal) => ({
      parent: value.parent,
      roles: value.roles,
      budgets: value.budgets,
    })
    if (GoalControl.fingerprint(stable(prior.journal)) !== GoalControl.fingerprint(stable(journal)))
      return yield* fail("CHECKPOINT_CONFLICT", "Checkpoint immutable admission changed")
    const bytes = Buffer.byteLength(JSON.stringify(journal))
    const changed = yield* db
      .update(GoalTickCheckpointTable)
      .set({
        journal,
        journal_hash: GoalControl.fingerprint(journal),
        logical_bytes: bytes,
        reserved_bytes: state === "committed" || state === "halted" ? bytes : prior.reserved_bytes,
        state,
        error_code: errorCode,
        revision: prior.revision + 1,
        updated_at: Date.now(),
      })
      .where(
        and(
          eq(GoalTickCheckpointTable.permit_id, prior.permit_id),
          eq(GoalTickCheckpointTable.revision, prior.revision),
          eq(GoalTickCheckpointTable.journal_hash, prior.journal_hash),
        ),
      )
      .returning()
      .all()
      .pipe(Effect.orDie)
    if (changed.length !== 1) return yield* fail("CHECKPOINT_CONFLICT", "Checkpoint compare-and-swap lost")
    const persisted = yield* read(db, prior.permit_id)
    if (!persisted) return yield* fail("CHECKPOINT_CONFLICT", "Committed checkpoint disappeared")
    return persisted
  })

export const recordResult = (db: Db, proof: GoalChildResult.Proof) =>
  db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const facts = yield* GoalChildResult.recheck(tx, proof)
        const unit = (yield* GoalChild.read(tx, facts.result.unitID))!
        const prior = yield* read(tx, unit.permit_id)
        if (!prior || unit.binding.version !== 2 || unit.binding.policy.checkpointHash !== prior.binding_hash)
          return yield* fail("CHECKPOINT_CONFLICT", "Result does not belong to this checkpoint")
        const existing = prior.journal.results.find(
          (result) => result.unitID === facts.result.unitID && result.stage === facts.result.stage,
        )
        if (existing) {
          if (GoalControl.fingerprint(existing) !== GoalControl.fingerprint(facts.result))
            return yield* fail("CHECKPOINT_CONFLICT", "Goal stage already has a different result")
          return prior
        }
        const roleIndex = prior.journal.roles.findIndex((role) => role.key === unit.role_key)
        if (roleIndex < 0) return yield* fail("CHECKPOINT_CONFLICT", "Result role is outside the fixed manifest")
        const current = yield* requireParent(tx, prior).pipe(Effect.exit)
        if (current._tag === "Failure" && Cause.hasInterrupts(current.cause))
          return yield* Effect.failCause(current.cause)
        const results = [...prior.journal.results, facts.result]
        const stage =
          facts.result.stage === "research"
            ? "finalizer.1"
            : facts.result.stage === "finalizer.1" && facts.result.outcome === "schema_invalid"
              ? "finalizer.2"
              : undefined
        const complete = stage === undefined
        const cursor = yield* resultCursor({ ...prior.journal, results }, prior.permit_id)
        const recorded = yield* tx
          .update(GoalChildUnitTable)
          .set({
            state: complete ? "result_recorded" : "admitted",
            inputs: unit.inputs.map((input) =>
              input.stage === facts.result.stage
                ? { ...input, resultRef: facts.result.messageID, resultHash: facts.result.resultHash }
                : input,
            ),
            updated_at: Date.now(),
          })
          .where(
            and(eq(GoalChildUnitTable.unit_id, unit.unit_id), eq(GoalChildUnitTable.binding_hash, facts.bindingHash)),
          )
          .returning({ id: GoalChildUnitTable.unit_id })
          .all()
          .pipe(Effect.orDie)
        if (recorded.length !== 1)
          return yield* fail("CHECKPOINT_CONFLICT", "Goal input result receipt was not committed")
        return yield* write(
          tx,
          prior,
          { ...prior.journal, results, cursor: current._tag === "Success" ? cursor : prior.journal.cursor },
          current._tag === "Success" ? "running" : "recovery_required",
          current._tag === "Success" ? null : "CHECKPOINT_CONTROL_CHANGED",
        )
      }),
    { behavior: "immediate" },
  ).pipe(GoalChildResult.withRuntimeIdentity(db))

/** Prepares exact projection bytes only after all real role results have been recorded. */
export const prepareMirrors = (
  db: Db,
  input: {
    permitID: string
    revision: number
    mirrors: GoalTickCheckpointSchema.Journal["mirrors"]
    nextState: string
  },
) =>
  db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const row = yield* read(tx, input.permitID)
        if (
          !row ||
          row.revision !== input.revision ||
          row.journal.cursor.role !== row.journal.roles.length ||
          row.journal.localEffects.some((effect) => ["prepared", "dispatched", "unknown"].includes(effect.state))
        )
          return yield* fail("CHECKPOINT_CONFLICT", "Checkpoint has unfinished or unknown work")
        yield* requireParent(tx, row)
        yield* GoalChildResult.inspectMany(tx, row.journal.results)
        if (row.state === "mirror_pending") {
          const expected = row.journal.mirrors.map((mirror) => ({
            ...mirror,
            state: "pending",
            observedVersion: null,
            observedHash: null,
          }))
          if (
            GoalControl.fingerprint(expected) !== GoalControl.fingerprint(input.mirrors) ||
            row.journal.nextState !== input.nextState
          )
            return yield* fail("CHECKPOINT_CONFLICT", "Prepared projection bytes cannot change")
          return row
        }
        if (
          input.mirrors.some(
            (mirror) => mirror.state !== "pending" || mirror.observedVersion !== null || mirror.observedHash !== null,
          ) ||
          new Set(input.mirrors.map((mirror) => mirror.documentID)).size !== input.mirrors.length
        )
          return yield* fail("CHECKPOINT_INVALID", "Projection preparation cannot claim an observed write")
        return yield* write(
          tx,
          row,
          {
            ...row.journal,
            mirrors: input.mirrors,
            nextState: input.nextState,
            nextStateHash: GoalControl.fingerprint(input.nextState),
          },
          "mirror_pending",
        )
      }),
    { behavior: "immediate" },
  ).pipe(GoalChildResult.withRuntimeIdentity(db))

/** Existing run-document body projection. The host supplies its trusted DocumentStore root.
 * SQL is deliberately not claimed to roll back an exclusive file write. A retry checks the exact
 * prior immutable version and exact successor content before repairing only the SQL confirmation. */
export const projectMirror = (db: Db, input: { permitID: string; documentID: string; directory: string }) =>
  db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const row = yield* read(tx, input.permitID)
        if (!row || row.state !== "mirror_pending")
          return yield* fail("CHECKPOINT_CONFLICT", "No prepared projection exists")
        yield* requireProjection(tx, row)
        const mirror = row.journal.mirrors.find((mirror) => mirror.documentID === input.documentID)
        if (!mirror || mirror.expectedVersion === null || mirror.expectedHash === null)
          return yield* fail("CHECKPOINT_INVALID", "Projection requires an existing immutable document revision")
        const observed = yield* Effect.try({
          try: () => {
            const store = DocumentStore.openExact(input.directory, [mirror.documentID])
            const previous = store.get(mirror.documentID, mirror.expectedVersion!)
            if (
              !previous ||
              previous.hash !== mirror.expectedHash ||
              previous.scope !== `run:${row.journal.parent.sessionID}`
            )
              throw new Error("projection source differs")
            const withoutHash = (doc: typeof previous) =>
              Object.fromEntries(Object.entries(doc!).filter(([key]) => key !== "hash"))
            if (previous.hash !== `sha256:${Hash.sha256(CanonicalJson.stringify(withoutHash(previous)))}`)
              throw new Error("projection source hash differs")
            const current = store.get(mirror.documentID)!
            const unchanged = previous.body === mirror.payload
            const expected = {
              ...withoutHash(previous),
              body: mirror.payload,
              version: unchanged ? previous.version : previous.version + 1,
              superseded_by: null,
            }
            if (current.version === previous.version && current.hash === previous.hash)
              store.update(mirror.documentID, mirror.payload)
            const result = DocumentStore.openExact(input.directory, [mirror.documentID]).get(mirror.documentID)!
            if (
              CanonicalJson.stringify(withoutHash(result)) !== CanonicalJson.stringify(expected) ||
              result.hash !== `sha256:${Hash.sha256(CanonicalJson.stringify(withoutHash(result)))}`
            )
              throw new Error("projection successor differs")
            return { version: result.version, hash: result.hash }
          },
          catch: () => fail("CHECKPOINT_CONFLICT", "Exact document projection could not be confirmed"),
        })
        if (mirror.state === "confirmed") {
          if (mirror.observedVersion !== observed.version || mirror.observedHash !== observed.hash)
            return yield* fail("CHECKPOINT_CONFLICT", "Confirmed document projection changed")
          return row
        }
        return yield* write(
          tx,
          row,
          {
            ...row.journal,
            mirrors: row.journal.mirrors.map((item) =>
              item.documentID === mirror.documentID
                ? {
                    ...item,
                    state: "confirmed" as const,
                    observedVersion: observed.version,
                    observedHash: observed.hash,
                  }
                : item,
            ),
          },
          "mirror_pending",
        )
      }),
    { behavior: "immediate" },
  ).pipe(GoalChildResult.withRuntimeIdentity(db))

/** Caller-supplied cursor values must exactly match the already prepared next-state object. */
export const settle = (db: Db, input: { permitID: string; revision: number }) =>
  db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const row = yield* read(tx, input.permitID)
        if (!row) return yield* fail("CHECKPOINT_CONFLICT", "Checkpoint revision changed")
        // The only terminal CAS increments the prepared revision once. An ACK-lost exact retry
        // reconciles that same immutable completion receipt without touching execution or files.
        if (row.state === "committed" && (row.revision === input.revision || row.revision === input.revision + 1))
          return row
        if (row.revision !== input.revision || row.state === "committed")
          return yield* fail("CHECKPOINT_CONFLICT", "Checkpoint revision changed")
        if (
          row.state !== "mirror_pending" ||
          row.journal.cursor.role !== row.journal.roles.length ||
          row.journal.mirrors.some((mirror) => mirror.state !== "confirmed") ||
          row.journal.nextState === null
        )
          return yield* fail("CHECKPOINT_RECOVERY_REQUIRED", "Checkpoint has unconfirmed projection or work")
        yield* requireProjection(tx, row)
        const next = Schema.decodeUnknownOption(
          Schema.fromJsonString(
            Schema.Struct({
              nextSeq: GoalTickCheckpointSchema.Cursor.fields.role,
              planVersion: GoalTickCheckpointSchema.Cursor.fields.role,
              phase: GoalControlSchema.Phase,
            }),
          ),
        )(row.journal.nextState)
        if (Option.isNone(next)) return yield* fail("CHECKPOINT_INVALID", "Prepared cursor settlement is invalid")
        const source = yield* permitAuthority(tx, row.permit_id, undefined, false)
        // Database's nested transaction is a savepoint on the captured connection: the permit/cursor
        // update and checkpoint terminal receipt all roll back together on any later write failure.
        if (row.journal.parent.steering.rows.length) {
          const consumed = yield* tx
            .update(SessionSteerTable)
            .set({ consumed_seq: Date.now() })
            .where(
              and(
                eq(SessionSteerTable.session_id, SessionSchema.ID.make(row.journal.parent.sessionID)),
                eq(SessionSteerTable.delivery, "goal_steer"),
                eq(SessionSteerTable.mutation_epoch, row.journal.parent.steering.mutationEpoch),
                isNull(SessionSteerTable.consumed_seq),
                isNull(SessionSteerTable.superseded_at),
                inArray(
                  SessionSteerTable.id,
                  row.journal.parent.steering.rows.map((item) => SessionMessage.ID.make(item.id)),
                ),
              ),
            )
            .returning({ id: SessionSteerTable.id })
            .all()
            .pipe(Effect.orDie)
          if (consumed.length !== row.journal.parent.steering.rows.length)
            return yield* fail("CHECKPOINT_CONFLICT", "Frozen steering settlement lost its exact rows")
        }
        yield* GoalControl.settleTick(db, { permit: source.permit, ...next.value })
        return yield* write(tx, row, row.journal, "committed")
      }),
    { behavior: "immediate" },
  ).pipe(GoalChildResult.withRuntimeIdentity(db))
