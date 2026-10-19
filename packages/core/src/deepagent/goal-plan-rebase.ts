export * as GoalPlanRebase from "./goal-plan-rebase"

import { and, desc, eq, ne, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { EventSequenceTable } from "../event/sql"
import { GoalControl } from "./goal-control"
import { GoalControlSchema } from "./goal-control.schema"
import { GoalControlCommandTable, GoalControlTable, GoalTickPermitTable } from "./goal-control.sql"
import { GoalTickCheckpoint } from "./goal-tick-checkpoint"
import { GoalTickCheckpointV2 } from "./goal-tick-checkpoint-v2"
import { GoalChildResult } from "./goal-child-result"
import { GoalTickProgram } from "./goal-tick-program"
import { GoalTickState } from "./goal-tick-state"
import { GoalPauseBoundary } from "./goal-pause-boundary"
import { GoalPlanRebaseSchema } from "./goal-plan-rebase.schema"
import { GoalPlanRebaseTable } from "./goal-plan-rebase.sql"
import { DeepAgentPlanStore } from "./plan-store"
import { DocumentStore } from "./document-store"

type Db = Database.Interface["db"]
type Reader = GoalTickCheckpoint.Reader
export type Row = typeof GoalPlanRebaseTable.$inferSelect
export type Authority = (
  db: Reader,
  sessionID: string,
  goalID: string,
) => Effect.Effect<void, GoalPlanRebaseSchema.Error>
const fail = (code: GoalPlanRebaseSchema.Error["code"], message: string) =>
  new GoalPlanRebaseSchema.Error({ code, message })
const hash = GoalTickProgram.hash
const canonical = GoalTickProgram.canonical
const terminal = (row: Row) => ["committed", "cancelled", "superseded"].includes(row.state)
const decode = <A>(schema: Schema.Decoder<A>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => fail("RECOVERY_REQUIRED", "Plan edit record failed strict decoding")),
  )

/** Inspect sizes before the driver materializes JSON. Cold reads never repair or project anything. */
export const read = (db: Reader, editID: string) =>
  Effect.gen(function* () {
    const size = yield* db
      .get<{ bytes: number; reserved: number; logical: number }>(
        sql`
    SELECT length(CAST(journal AS BLOB)) AS bytes,reserved_bytes AS reserved,logical_bytes AS logical
    FROM goal_plan_rebase WHERE edit_id=${editID}`,
      )
      .pipe(Effect.orDie)
    if (!size) return undefined
    if (
      !Number.isSafeInteger(size.bytes) ||
      size.bytes < 1 ||
      size.bytes > GoalPlanRebaseSchema.MAX_BYTES ||
      size.logical !== size.bytes ||
      size.reserved < size.bytes ||
      size.reserved > GoalPlanRebaseSchema.MAX_BYTES
    )
      return yield* fail("RECOVERY_REQUIRED", "Plan edit exceeds its bounded storage allocation")
    const row = yield* db
      .select()
      .from(GoalPlanRebaseTable)
      .where(eq(GoalPlanRebaseTable.edit_id, editID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return yield* fail("RECOVERY_REQUIRED", "Plan edit disappeared during read")
    yield* decode(GoalPlanRebaseSchema.Journal, row.journal)
    if (
      hash(row.journal) !== row.journal_hash ||
      row.goal_id !== row.journal.begin.goalID ||
      row.session_id !== row.journal.begin.sessionID ||
      row.target_plan_revision !== row.source_plan_revision + 1 ||
      new Set(row.journal.commands.map((item) => item.command.request.requestID)).size !== row.journal.commands.length
    )
      return yield* fail("RECOVERY_REQUIRED", "Plan edit immutable binding changed")
    for (const item of row.journal.commands) {
      if (
        hash(item.command) !== item.requestHash ||
        item.command.request.sessionID !== row.session_id ||
        item.command.request.goalID !== row.goal_id ||
        (item.command.action !== "begin" && item.command.request.editID !== row.edit_id) ||
        (item.receipt !== null &&
          (item.receipt.requestHash !== item.requestHash ||
            item.receipt.requestID !== item.command.request.requestID ||
            item.receipt.editID !== row.edit_id ||
            GoalTickProgram.bytes(item.receipt) > GoalPlanRebaseSchema.RECEIPT_BYTES))
      )
        return yield* fail("RECOVERY_REQUIRED", "Plan edit historical command binding changed")
    }
    if (row.journal.controlInterruption) {
      const interrupted = row.journal.controlInterruption
      const command = yield* db
        .select({
          action: GoalControlCommandTable.action,
          revision: GoalControlCommandTable.revision,
          sessionID: GoalControlCommandTable.session_id,
          goalID: GoalControlCommandTable.goal_id,
        })
        .from(GoalControlCommandTable)
        .where(eq(GoalControlCommandTable.command_id, interrupted.commandID))
        .get()
        .pipe(Effect.orDie)
      if (
        !command ||
        command.sessionID !== row.session_id ||
        command.goalID !== row.goal_id ||
        `control_${command.action}` !== interrupted.reason ||
        command.revision !== interrupted.revision ||
        row.expected_control_revision !== interrupted.revision
      )
        return yield* fail("RECOVERY_REQUIRED", "Plan edit control interruption lost its actual control command")
    }
    if (
      row.journal.source &&
      (row.source_receipt_hash !== row.journal.source.receiptHash ||
        row.source_plan_revision !== row.journal.source.planRevision ||
        row.journal.source.baselineDocsHash !== hash(row.journal.source.documents))
    )
      return yield* fail("RECOVERY_REQUIRED", "Plan edit source receipt changed")
    if (row.journal.source) {
      const plan = row.journal.source.documents.find((item) => item.id === row.journal.source!.planDocID)
      if (
        !plan ||
        plan.type !== "plan" ||
        plan.version !== row.journal.source.planDocVersion ||
        hash(plan) !== row.journal.source.planDocHash ||
        new Set(row.journal.source.documents.map((item) => item.id)).size !== row.journal.source.documents.length ||
        new Set(row.journal.source.attemptedStepIDs).size !== row.journal.source.attemptedStepIDs.length
      )
        return yield* fail("RECOVERY_REQUIRED", "Plan edit source plan or identity set is inconsistent")
    }
    if (row.journal.documents.some((item) => item.payloadHash !== hash(item.payload)))
      return yield* fail("RECOVERY_REQUIRED", "Plan edit document payload changed")
    if (row.journal.preparedAt !== null) {
      const applied = row.journal.commands.filter((item) => item.command.action === "apply")
      if (
        applied.length !== 1 ||
        applied[0].command.action !== "apply" ||
        hash(applied[0].command.request.candidate) !== row.journal.candidateHash ||
        row.journal.source === null ||
        row.journal.nextState === null ||
        row.journal.documents.length !== row.journal.source.documents.length ||
        new Set(row.journal.documents.map((item) => item.documentID)).size !== row.journal.documents.length
      )
        return yield* fail("RECOVERY_REQUIRED", "Prepared edit lost its exact candidate request")
      for (const mirror of row.journal.documents) {
        const payload = yield* decode(Schema.fromJsonString(GoalTickProgram.DocumentPayload), mirror.payload)
        const original = row.journal.source.documents.find((item) => item.id === mirror.documentID)
        if (
          !original ||
          payload.id !== mirror.documentID ||
          canonical(payload) !== mirror.payload ||
          mirror.expectedVersion !== original.version ||
          mirror.expectedHash !== hash(original) ||
          (mirror.state === "confirmed"
            ? mirror.observedVersion !== payload.version || mirror.observedHash !== hash(payload)
            : mirror.observedVersion !== null || mirror.observedHash !== null)
        )
          return yield* fail("RECOVERY_REQUIRED", "Prepared edit projection differs from its exact source and payload")
      }
    }
    if (row.state === "committed") {
      if (
        !row.journal.source ||
        !row.journal.nextState ||
        row.journal.preparedAt === null ||
        row.journal.committedAt === null ||
        row.journal.documents.some((item) => item.state !== "confirmed") ||
        row.journal.commands.some((item) => item.receipt === null) ||
        row.journal.committedReceiptHash !==
          hash({
            editID: row.edit_id,
            source: row.source_receipt_hash,
            candidate: row.journal.candidateHash,
            sourcePlanRevision: row.source_plan_revision,
            targetPlanRevision: row.target_plan_revision,
            nextSeq: row.journal.source.nextSeq,
            documents: row.journal.documents,
            nextState: hash(row.journal.nextState),
            preparedAt: row.journal.preparedAt,
            committedAt: row.journal.committedAt,
          })
      )
        return yield* fail("RECOVERY_REQUIRED", "Committed edit receipt does not bind the complete frozen candidate")
    }
    return row
  })

const write = (
  db: Reader,
  row: Row,
  journal: GoalPlanRebaseSchema.Journal,
  state: Row["state"],
  extra: Partial<Row> = {},
) =>
  Effect.gen(function* () {
    yield* decode(GoalPlanRebaseSchema.Journal, journal)
    if (
      journal.commands.some(
        (item) => item.receipt !== null && GoalTickProgram.bytes(item.receipt) > GoalPlanRebaseSchema.RECEIPT_BYTES,
      )
    )
      return yield* fail("CAPACITY", "Plan edit receipt exceeds its immutable encoded slot")
    const logical = Buffer.byteLength(JSON.stringify(journal))
    // Empty receipt slots and one recovery command remain available before every external effect.
    const reserve =
      logical +
      journal.commands.filter((item) => item.receipt === null).length * GoalPlanRebaseSchema.RECEIPT_BYTES +
      (GoalPlanRebaseSchema.MAX_COMMANDS - journal.commands.length) * (GoalPlanRebaseSchema.RECEIPT_BYTES + 8192) +
      8192
    if (reserve > row.reserved_bytes)
      return yield* fail("CAPACITY", "Plan edit cannot reserve its remaining command and projection receipts")
    const updated = yield* db
      .update(GoalPlanRebaseTable)
      .set({
        ...extra,
        journal,
        state,
        journal_hash: hash(journal),
        logical_bytes: logical,
        revision: row.revision + 1,
        updated_at: Date.now(),
      })
      .where(and(eq(GoalPlanRebaseTable.edit_id, row.edit_id), eq(GoalPlanRebaseTable.revision, row.revision)))
      .returning()
      .get()
      .pipe(Effect.orDie)
    if (!updated) return yield* fail("REVISION_CONFLICT", "Plan edit revision changed")
    return updated
  })

const active = (db: Reader, goalID: string) =>
  db
    .select()
    .from(GoalTickPermitTable)
    .where(and(eq(GoalTickPermitTable.goal_id, goalID), ne(GoalTickPermitTable.state, "settled")))
    .limit(2)
    .all()
    .pipe(Effect.orDie)

/** Read bounded committed metadata only. Control callers must still audit the execution source below. */
const readBaseline = (db: Reader, goal: GoalControl.Row) =>
  Effect.gen(function* () {
    const last = yield* db
      .select()
      .from(GoalTickPermitTable)
      .where(and(eq(GoalTickPermitTable.goal_id, goal.goal_id), eq(GoalTickPermitTable.state, "settled")))
      .orderBy(desc(GoalTickPermitTable.tick_seq))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    const rebase = goal.plan_rebase_id ? yield* read(db, goal.plan_rebase_id) : undefined
    if (
      goal.plan_revision > 0 &&
      (!rebase ||
        rebase.state !== "committed" ||
        rebase.target_plan_revision !== goal.plan_revision ||
        !rebase.journal.committedReceiptHash)
    )
      return yield* fail("RECOVERY_REQUIRED", "Goal structural generation has no committed edit receipt")
    const pause = last?.outcome === "paused" ? yield* GoalPauseBoundary.read(db, last.permit_id) : undefined
    const checkpoint = last ? yield* GoalTickCheckpointV2.read(db, last.permit_id) : undefined
    if (last?.outcome === "paused" && !GoalPauseBoundary.matchesCommittedBaseline(goal, last, pause, checkpoint))
      return yield* fail("RECOVERY_REQUIRED", "Goal pause has no exact committed safe boundary")
    const paused = pause
      ? { documents: pause.record.documents, receiptHash: pause.record_hash,
          planRevision: pause.record.planRevision, planRebaseID: pause.record.planRebaseID }
      : undefined
    if (
      last && !paused &&
      (!checkpoint ||
        checkpoint.state !== "committed" ||
        checkpoint.journal.documents.some((item) => item.state !== "confirmed") ||
        checkpoint.journal.documents.length !== checkpoint.journal.program.documents.length ||
        last.next_seq !== goal.next_seq)
    )
      return yield* fail("RECOVERY_REQUIRED", "Goal tick is not fully settled with confirmed mirrors")
    const edited = rebase && rebase.journal.source?.nextSeq === goal.next_seq
    const documents = edited
      ? rebase.journal.documents
      : paused
        ? paused.documents
      : checkpoint
        ? checkpoint.journal.documents
        : goal.initialization.ownedPreparation?.documents
    if (!documents || documents.length < 2 || documents.length > 8 || goal.next_seq !== (last?.next_seq ?? 0))
      return yield* fail("RECOVERY_REQUIRED", "Goal has no exact committed source document set")
    const payloads = yield* Effect.forEach(documents, (item) =>
      decode(Schema.fromJsonString(GoalTickProgram.DocumentPayload), item.payload),
    )
    const plan = payloads.find((item) => item.id === goal.plan_doc_id)
    if (!plan || plan.version !== goal.plan_version)
      return yield* fail("RECOVERY_REQUIRED", "Goal plan cursor differs from its source receipt")
    if (paused && !edited && (paused.planRevision !== goal.plan_revision || paused.planRebaseID !== goal.plan_rebase_id))
      return yield* fail("RECOVERY_REQUIRED", "Paused Goal belongs to a different structural generation")
    if (
      checkpoint &&
      !paused &&
      !edited &&
      goal.plan_revision > 0 &&
      (checkpoint.journal.program.version !== 3 ||
        checkpoint.journal.program.planLineage.planRevision !== goal.plan_revision ||
        checkpoint.journal.program.planLineage.rebaseID !== goal.plan_rebase_id)
    )
      return yield* fail("RECOVERY_REQUIRED", "Goal checkpoint belongs to a different structural generation")
    return {
      last,
      checkpoint,
      pauseReceiptHash: paused?.receiptHash,
      documents: payloads,
      receiptHash: edited
        ? rebase.journal.committedReceiptHash!
        : (paused?.receiptHash ?? checkpoint?.journal_hash ?? hash({ initialization: goal.initialization_hash, documents: payloads })),
      permitID: last?.permit_id ?? null,
      attemptedStepIDs: rebase?.journal.source?.attemptedStepIDs ?? [],
    }
  })

/** A source is the complete last committed mirror set, never a caller's receipt assertion. */
export const baseline = (db: Reader, goal: GoalControl.Row) =>
  Effect.gen(function* () {
    const data = yield* readBaseline(db, goal)
    if (data.last?.outcome === "paused") {
      const audited = yield* GoalPauseBoundary.baseline(db, goal, data.last)
      if (audited.receiptHash !== data.pauseReceiptHash)
        return yield* fail("RECOVERY_REQUIRED", "Goal pause changed during execution audit")
    }
    if (data.checkpoint && data.last?.outcome !== "paused")
      yield* GoalChildResult.inspectMany(db, data.checkpoint.journal.results)
    return {
      documents: data.documents,
      receiptHash: data.receiptHash,
      permitID: data.permitID,
      attemptedStepIDs: data.attemptedStepIDs,
    }
  })

/** Statistics are observations of committed bytes, never an execution or plan-edit proof.
 * The bounded metadata reader cannot inspect provider/tool history or expose an unaudited document set. */
export const progress = (db: Reader, row: GoalControl.Row) =>
  Effect.gen(function* () {
    if (row.initialization.executionContract !== "owned-goal-v2" || row.preparation !== "ready") return undefined
    const source = yield* readBaseline(db, row)
    const document = source.documents.find((item) => item.id === `doc:run_context:${row.goal_id}`)
    if (!document || document.type !== "run_context" || document.scope !== `run:${row.session_id}`) return undefined
    const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(GoalTickState.Runtime))(document.body)
    if (Option.isNone(decoded)) return undefined
    const state = GoalTickState.requireState(decoded.value)
    if (state.goalId !== row.goal_id || state.sessionId !== row.session_id ||
        state.planDocId !== row.plan_doc_id || state.ledger.ticks !== row.next_seq) return undefined
    const current = yield* GoalControl.current(db, row.session_id)
    if (!current || current.goal_id !== row.goal_id || current.revision !== row.revision ||
        current.next_seq !== row.next_seq || current.plan_revision !== row.plan_revision ||
        current.plan_rebase_id !== row.plan_rebase_id || current.plan_version !== row.plan_version) return undefined
    // Runtime already enforces these exact Progress field bounds; keep malformed observations optional.
    const decodedProgress = Schema.decodeUnknownOption(GoalControlSchema.Progress)({
      ledger: { ticks: state.ledger.ticks, tokens: state.ledger.tokens, cost: state.ledger.cost,
        wallclockMs: state.ledger.wallclockMs },
      stallCount: state.stallCount,
      gaps: [...state.gaps],
    })
    return Option.isSome(decodedProgress) ? decodedProgress.value : undefined
  }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))

const source = (db: Reader, goal: GoalControl.Row) =>
  Effect.gen(function* () {
    const base = yield* baseline(db, goal)
    const parent = yield* GoalControl.session(db, goal.session_id)
    const sequence = yield* db
      .select()
      .from(EventSequenceTable)
      .where(eq(EventSequenceTable.aggregate_id, parent.id))
      .get()
      .pipe(Effect.orDie)
    const plan = base.documents.find((item) => item.id === goal.plan_doc_id)!
    const parsed = DeepAgentPlanStore.decodePlanDoc(plan.body)
    if (!sequence || !parsed)
      return yield* fail("RECOVERY_REQUIRED", "Goal source plan or parent history is unavailable")
    return yield* decode(GoalPlanRebaseSchema.Source, {
      planRevision: goal.plan_revision,
      controlRevision: goal.revision,
      nextSeq: goal.next_seq,
      priorRebaseID: goal.plan_rebase_id,
      permitID: base.permitID,
      receiptHash: base.receiptHash,
      planDocID: plan.id,
      planDocVersion: plan.version,
      planDocHash: hash(plan),
      baselineDocsHash: hash(base.documents),
      documents: base.documents,
      parentAuthorityHash: GoalControl.fingerprint(GoalTickCheckpoint.authority(parent)),
      parentEventSeq: sequence.seq,
      attemptedStepIDs: [
        ...new Set([
          ...base.attemptedStepIDs,
          ...parsed.steps.filter((step) => step.status !== "pending").map((step) => step.step_id),
        ]),
      ],
    })
  })

const receipt = (
  row: Row,
  goal: GoalControl.Row,
  command: GoalPlanRebaseSchema.Command,
): GoalPlanRebaseSchema.Receipt => ({
  version: 1,
  requestID: command.request.requestID,
  requestHash: hash(command),
  action: command.action,
  editID: row.edit_id,
  goalID: row.goal_id,
  sessionID: row.session_id,
  revision: row.revision,
  state: row.state,
  sourcePlanRevision: row.source_plan_revision,
  sourceControlRevision: row.source_control_revision,
  targetPlanRevision: row.target_plan_revision,
  controlRevision: goal.revision,
  sourceReceiptHash: row.source_receipt_hash,
  candidateHash: row.journal.candidateHash,
  committedReceiptHash: row.journal.committedReceiptHash,
  planDocID: goal.plan_doc_id,
  planDocVersion: goal.plan_version,
  planDocHash:
    row.state === "committed"
      ? (row.journal.documents.find((item) => item.documentID === goal.plan_doc_id)?.observedHash ?? null)
      : (row.journal.source?.planDocHash ?? null),
  nextSeq: goal.next_seq,
  confirmedDocuments: row.journal.documents.filter((item) => item.state === "confirmed").length,
  totalDocuments: row.journal.documents.length,
  projections: row.journal.documents.map((item) => ({
    documentID: item.documentID,
    state: item.state,
    version: item.observedVersion,
    hash: item.observedHash,
  })),
  partial: row.journal.fileStarted && row.state !== "committed",
  execution:
    row.state === "waiting_boundary"
      ? "waiting_boundary"
      : row.state === "recovery_required"
        ? "blocked"
        : GoalControl.isTerminal(goal.requested_phase)
          ? "terminal"
          : "paused",
  recordedAt: row.journal.committedAt ?? row.journal.preparedAt ?? row.created_at,
})

export const response = (db: Reader, row: Row, requestID: string, replayed: boolean, authorize: Authority) =>
  Effect.gen(function* () {
    yield* authorize(db, row.session_id, row.goal_id)
    const goal = yield* GoalControl.requireTarget(db, row.goal_id, row.session_id)
    const inflight = yield* active(db, row.goal_id)
    const confirmed = row.journal.documents.filter((item) => item.state === "confirmed").length
    const resumable =
      terminal(row) &&
      goal.pending_rebase_id === null &&
      goal.requested_phase === "paused" &&
      !goal.recovery_reason &&
      inflight.length === 0
        ? yield* Effect.gen(function* () {
            const parent = yield* GoalControl.session(db, row.session_id)
            if (
              row.journal.source?.parentAuthorityHash !== GoalControl.fingerprint(GoalTickCheckpoint.authority(parent))
            )
              return false
            const current = yield* baseline(db, goal)
            const document = current.documents.find((item) => item.id === `doc:run_context:${goal.goal_id}`)
            if (!document) return false
            const state = yield* decode(Schema.fromJsonString(GoalTickState.Runtime), document.body)
            return GoalTickState.remainingBudget(state)
          })
        : false
    return {
      version: 1,
      originalReceipt:
        row.journal.commands.find((item) => item.command.request.requestID === requestID)?.receipt ?? null,
      current: {
        editID: row.edit_id,
        revision: row.revision,
        state: row.state,
        controlRevision: goal.revision,
        planRevision: goal.plan_revision,
        confirmedDocuments: confirmed,
        totalDocuments: row.journal.documents.length,
        partial: row.journal.fileStarted && row.state !== "committed",
        safeToResume: resumable,
        execution:
          goal.recovery_reason ||
          inflight.some((item) => item.state === "unknown" || item.owner_id !== GoalControl.ownerID) ||
          (inflight.length > 0 && goal.requested_phase !== "running") ||
          row.state === "recovery_required"
            ? "blocked"
            : goal.requested_phase === "running"
              ? row.state === "waiting_boundary"
                ? "waiting_boundary"
                : "running"
              : GoalControl.isTerminal(goal.requested_phase)
                ? "terminal"
                : "paused",
        retry:
          row.state === "waiting_boundary"
            ? "refresh"
            : row.state === "prepared" || row.state === "mirror_pending" || row.state === "recovery_required"
              ? "reconcile"
              : "none",
        editSource: row.journal.source
          ? {
              planDocument: row.journal.source.documents.find((item) => item.id === row.journal.source!.planDocID)!,
              planDocHash: row.journal.source.planDocHash,
              sourceReceiptHash: row.journal.source.receiptHash,
              baselineDocsHash: row.journal.source.baselineDocsHash,
              attemptedStepIDs: row.journal.source.attemptedStepIDs,
            }
          : null,
      },
      replayed,
    } satisfies GoalPlanRebaseSchema.Response
  })

export const historical = (db: Reader, command: GoalPlanRebaseSchema.Command) =>
  Effect.gen(function* () {
    const prior = yield* GoalControl.command(db, command.request.sessionID, command.request.requestID)
    if (!prior) return undefined
    if (
      prior.action !== `rebase_${command.action}` ||
      prior.request_hash !== hash(command) ||
      prior.goal_id !== command.request.goalID
    )
      return yield* fail("REQUEST_CONFLICT", "Session requestID already belongs to a different immutable command")
    const editID = command.action === "begin" ? `rebase_${hash(command)}` : command.request.editID
    const row = yield* read(db, editID)
    const item = row?.journal.commands.find((item) => item.command.request.requestID === command.request.requestID)
    if (!row || !item || item.requestHash !== hash(command))
      return yield* fail("RECOVERY_REQUIRED", "Original plan edit receipt is unavailable")
    return row
  })

const register = (db: Reader, goal: GoalControl.Row, command: GoalPlanRebaseSchema.Command) =>
  db
    .insert(GoalControlCommandTable)
    .values({
      command_id: `goalcommand_${hash([command.request.sessionID, command.request.requestID])}`,
      session_id: goal.session_id,
      goal_id: goal.goal_id,
      request_id: command.request.requestID,
      request_hash: hash(command),
      action: `rebase_${command.action}`,
      revision: goal.revision,
      receipt: null,
      wake_state: "none",
      wake_key: `rebase:${hash(command)}`,
      tick_seq: goal.next_seq,
      plan_version: goal.plan_version,
      publish_attempts: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
    })
    .run()
    .pipe(Effect.orDie)

export const begin = (db: Db, input: GoalPlanRebaseSchema.Begin, authorize: Authority) =>
  db.transaction(
    (tx) =>
      Effect.gen(function* () {
        yield* decode(GoalPlanRebaseSchema.Begin, input)
        yield* authorize(tx, input.sessionID, input.goalID)
        const command = { action: "begin", request: input } as const
        const prior = yield* historical(tx, command)
        if (prior) return yield* response(tx, prior, input.requestID, true, authorize)
        const goal = yield* GoalControl.requireTarget(tx, input.goalID, input.sessionID)
        if (goal.revision !== input.expectedControlRevision)
          return yield* fail("REVISION_CONFLICT", "Goal control revision changed")
        if (goal.initialization.executionContract !== "owned-goal-v2" || goal.preparation !== "ready")
          return yield* fail("UNAVAILABLE", "Plan rebase requires a prepared owned Goal")
        if (["done", "rolled_back"].includes(goal.requested_phase))
          return yield* fail("TARGET_CONFLICT", "Completed Goals cannot be reopened")
        if (goal.pending_rebase_id) return yield* fail("TARGET_CONFLICT", "Goal already has a pending plan edit")
        const permits = yield* active(tx, goal.goal_id)
        if (
          goal.recovery_reason ||
          permits.some((item) => item.state !== "issued" || item.owner_id !== GoalControl.ownerID)
        )
          return yield* fail("RECOVERY_REQUIRED", "Goal has an unresolved execution boundary")
        const capacity = yield* tx
          .get<{
            records: number
            bytes: number
          }>(sql`SELECT count(*) AS records,coalesce(sum(reserved_bytes),0) AS bytes FROM goal_plan_rebase`)
          .pipe(Effect.orDie)
        if (
          !capacity ||
          capacity.records >= GoalPlanRebaseSchema.MAX_RECORDS ||
          capacity.bytes + GoalPlanRebaseSchema.MAX_BYTES > GoalPlanRebaseSchema.MAX_INSTANCE_BYTES
        )
          return yield* fail("CAPACITY", "Plan edit business journal capacity is exhausted")
        const now = Date.now()
        const frozen = permits.length ? null : yield* source(tx, goal)
        const journal: GoalPlanRebaseSchema.Journal = {
          version: 1,
          begin: input,
          source: frozen,
          commands: [{ command, requestHash: hash(command), receipt: null }],
          candidateHash: null,
          documents: [],
          nextState: null,
          fileStarted: false,
          committedReceiptHash: null,
          preparedAt: null,
          committedAt: null,
        }
        const row = yield* tx
          .insert(GoalPlanRebaseTable)
          .values({
            edit_id: `rebase_${hash(command)}`,
            goal_id: goal.goal_id,
            session_id: goal.session_id,
            version: 1,
            revision: 0,
            state: permits.length ? "waiting_boundary" : "ready",
            source_plan_revision: goal.plan_revision,
            target_plan_revision: goal.plan_revision + 1,
            source_control_revision: goal.revision,
            expected_control_revision: goal.revision + (permits.length ? 0 : 1),
            source_receipt_hash: frozen?.receiptHash ?? null,
            journal,
            journal_hash: hash(journal),
            logical_bytes: Buffer.byteLength(JSON.stringify(journal)),
            reserved_bytes: GoalPlanRebaseSchema.MAX_BYTES,
            created_at: now,
            updated_at: now,
          })
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* fail("UNAVAILABLE", "Plan edit was not stored")
        const changed = yield* tx
          .update(GoalControlTable)
          .set({
            pending_rebase_id: row.edit_id,
            ...(permits.length ? {} : { revision: goal.revision + 1, requested_phase: "paused" as const }),
            updated_at: now,
          })
          .where(eq(GoalControlTable.goal_id, goal.goal_id))
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (!changed) return yield* fail("UNAVAILABLE", "Plan edit fence was not stored")
        yield* tx
          .update(GoalControlCommandTable)
          .set({ wake_state: "superseded" })
          .where(
            and(eq(GoalControlCommandTable.goal_id, goal.goal_id), eq(GoalControlCommandTable.wake_state, "pending")),
          )
          .run()
          .pipe(Effect.orDie)
        yield* register(tx, changed, command)
        const recorded = yield* write(
          tx,
          row,
          {
            ...journal,
            commands: [
              {
                command,
                requestHash: hash(command),
                receipt: receipt({ ...row, revision: row.revision + 1 }, changed, command),
              },
            ],
          },
          row.state,
        )
        return yield* response(tx, recorded, input.requestID, false, authorize)
      }),
    { behavior: "immediate" },
  ).pipe(GoalChildResult.withRuntimeIdentity(db))

/** Called only inside checkpoint settlement's SQL transaction, after every mirror and permit commit. */
export const readyPending = (db: Reader, goalID: string) =>
  Effect.gen(function* () {
    const goal = yield* GoalControl.get(db, goalID)
    if (!goal?.pending_rebase_id) return
    const row = yield* read(db, goal.pending_rebase_id)
    if (!row || row.state !== "waiting_boundary") return
    if ((yield* active(db, goalID)).length || goal.recovery_reason) return
    if (["done", "rolled_back"].includes(goal.requested_phase)) {
      yield* write(db, row, row.journal, "recovery_required")
      return
    }
    const frozen = yield* source(db, goal)
    yield* db
      .update(GoalControlTable)
      .set({ requested_phase: "paused", revision: goal.revision + 1, updated_at: Date.now() })
      .where(eq(GoalControlTable.goal_id, goalID))
      .run()
      .pipe(Effect.orDie)
    yield* write(db, row, { ...row.journal, source: frozen }, "ready", {
      source_receipt_hash: frozen.receiptHash,
      expected_control_revision: goal.revision + 1,
    })
  })

/** User control always wins. This shares the ordinary control transaction, without replacing its immutable receipt. */
export const onControl = (db: Reader, goal: GoalControl.Row, action: "pause" | "stop", requestID: string) =>
  Effect.gen(function* () {
    if (!goal.pending_rebase_id) return goal
    // A corrupt edit must never prevent stopping execution. Its stale revision remains a hard projection fence.
    const row = yield* read(db, goal.pending_rebase_id).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!row || terminal(row)) return goal
    const journal = {
      ...row.journal,
      controlInterruption: {
        reason: action === "stop" ? ("control_stop" as const) : ("control_pause" as const),
        commandID: `goalcmd_${GoalControl.fingerprint([goal.session_id, requestID])}`,
        revision: goal.revision,
      },
    }
    if (row.journal.fileStarted) {
      yield* write(db, row, journal, "recovery_required", { expected_control_revision: goal.revision })
      return goal
    }
    const changed = yield* db
      .update(GoalControlTable)
      .set({ pending_rebase_id: null })
      .where(eq(GoalControlTable.goal_id, goal.goal_id))
      .returning()
      .get()
      .pipe(Effect.orDie)
    if (!changed) return yield* fail("UNAVAILABLE", "Goal control lost its edit cancellation")
    const cancelled = { ...row, state: "cancelled" as const, revision: row.revision + 1, journal }
    yield* write(
      db,
      row,
      {
        ...journal,
        commands: journal.commands.map((item) =>
          item.receipt ? item : { ...item, receipt: receipt(cancelled, changed, item.command) },
        ),
      },
      "cancelled",
      {
        expected_control_revision: goal.revision,
      },
    )
    return changed
  })

export function validateCandidate(source: GoalPlanRebaseSchema.Source, candidate: GoalPlanRebaseSchema.Candidate) {
  const plan = DeepAgentPlanStore.decodePlanDoc(source.documents.find((item) => item.id === source.planDocID)!.body)
  if (
    !plan ||
    !Schema.is(GoalPlanRebaseSchema.Candidate)(candidate) ||
    new Set(candidate.steps.map((step) => step.step_id)).size !== candidate.steps.length ||
    new Set(candidate.dispositions.map((item) => item.stepID)).size !== candidate.dispositions.length
  )
    throw fail("INVALID_CANDIDATE", "Plan steps or disposition identities are invalid")
  if (
    candidate.activeStepID !== null &&
    !candidate.steps.some((step) => step.step_id === candidate.activeStepID && step.status === "active")
  )
    throw fail("INVALID_CANDIDATE", "Active plan selection must identify the retained active step")
  for (const step of plan.steps) {
    const next = candidate.steps.find((item) => item.step_id === step.step_id)
    if (step.status === "done" && (!next || canonical(next) !== canonical(step)))
      throw fail("IMMUTABLE_COMPLETED_STEP", "Completed step identity, acceptance, status and evidence are immutable")
    if (source.attemptedStepIDs.includes(step.step_id) && !next)
      throw fail("ATTEMPTED_STEP_REQUIRED", "Attempted step IDs cannot be removed or reused")
    if (
      next &&
      (canonical(next.evidence ?? []) !== canonical(step.evidence ?? []) || next.assigned_agent !== step.assigned_agent)
    )
      throw fail("INVALID_CANDIDATE", "Plan edit cannot invent evidence or change an assigned execution role")
    if (
      next &&
      step.status === "pending" &&
      !source.attemptedStepIDs.includes(step.step_id) &&
      next.status !== "pending"
    )
      throw fail("INVALID_CANDIDATE", "Plan edit cannot advance an unattempted step")
    if (next && step.status !== "done" && next.status === "done")
      throw fail("INVALID_CANDIDATE", "Plan edit cannot fabricate completion")
    if (
      next &&
      step.status !== "done" &&
      source.attemptedStepIDs.includes(step.step_id) &&
      canonical(next) !== canonical(step) &&
      !candidate.dispositions.some((item) => item.stepID === step.step_id && item.reason.trim().length)
    )
      throw fail("DISPOSITION_REQUIRED", "Changing a settled unsatisfied attempt requires its disposition reason")
  }
  if (
    candidate.steps.some(
      (step) =>
        !plan.steps.some((item) => item.step_id === step.step_id) &&
        (source.attemptedStepIDs.includes(step.step_id) ||
          step.status !== "pending" ||
          (step.evidence?.length ?? 0) > 0 ||
          step.assigned_agent != null),
    )
  )
    throw fail("INVALID_CANDIDATE", "New steps must be future work with unused IDs and no fabricated evidence")
  if (candidate.dispositions.some((item) => !source.attemptedStepIDs.includes(item.stepID)))
    throw fail("INVALID_CANDIDATE", "Disposition references an unattempted step")
  return { ...plan, steps: candidate.steps, active_step_id: candidate.activeStepID }
}

export const requireCurrent = (db: Reader, row: Row, authorize: Authority) =>
  Effect.gen(function* () {
    yield* authorize(db, row.session_id, row.goal_id)
    const goal = yield* GoalControl.requireTarget(db, row.goal_id, row.session_id)
    if (
      !row.journal.source ||
      goal.pending_rebase_id !== row.edit_id ||
      goal.revision !== row.expected_control_revision ||
      goal.plan_revision !== row.source_plan_revision ||
      (goal.requested_phase !== "paused" && !(row.journal.controlInterruption && goal.requested_phase === "stopped")) ||
      goal.recovery_reason ||
      (yield* active(db, goal.goal_id)).length
    )
      return yield* fail("REVISION_CONFLICT", "Plan edit lost its paused control boundary")
    const parent = yield* GoalControl.session(db, row.session_id)
    const sequence = yield* db
      .select()
      .from(EventSequenceTable)
      .where(eq(EventSequenceTable.aggregate_id, parent.id))
      .get()
      .pipe(Effect.orDie)
    if (
      !sequence ||
      sequence.seq !== row.journal.source.parentEventSeq ||
      GoalControl.fingerprint(GoalTickCheckpoint.authority(parent)) !== row.journal.source.parentAuthorityHash
    )
      return yield* fail("PARENT_CHANGED", "Parent authority or event history changed after the edit boundary")
    return goal
  })

/** Actual persisted source readback; an approval cannot authorize a newer or externally edited plan. */
export function requireDocuments(row: Row, directory: string, allowPrepared: boolean) {
  const source = row.journal.source
  if (!source) throw fail("WAITING_BOUNDARY", "Plan edit has no settled source yet")
  const store = DocumentStore.openExact(
    directory,
    source.documents.map((item) => item.id),
  )
  for (const document of source.documents) {
    const actual = store.get(document.id)
    const payload = actual ? Object.fromEntries(Object.entries(actual).filter(([key]) => key !== "hash")) : null
    const prepared = row.journal.documents.find((item) => item.documentID === document.id)
    if (
      !actual ||
      (canonical(payload) !== canonical(document) &&
        (!allowPrepared || !prepared || canonical(payload) !== prepared.payload))
    )
      throw fail("PLAN_CONFLICT", "Goal document changed outside the exact frozen edit")
  }
}

const append = (row: Row, command: GoalPlanRebaseSchema.Command) => {
  if (row.journal.commands.length >= (command.action === "cancel" || command.action === "reconcile" ? 32 : 31))
    throw fail("CAPACITY", "Plan edit command capacity reserves the final recovery slot")
  return [...row.journal.commands, { command, requestHash: hash(command), receipt: null }]
}

export const prepare = (db: Db, input: GoalPlanRebaseSchema.Apply, directory: string, authorize: Authority) =>
  db.transaction(
    (tx) =>
      Effect.gen(function* () {
        yield* decode(GoalPlanRebaseSchema.Apply, input)
        yield* authorize(tx, input.sessionID, input.goalID)
        const command = { action: "apply", request: input } as const
        const prior = yield* historical(tx, command)
        if (prior) return { row: prior, replayed: true }
        const row = yield* read(tx, input.editID)
        if (!row || row.session_id !== input.sessionID || row.goal_id !== input.goalID)
          return yield* fail("NOT_FOUND", "Plan edit does not belong to the requested Goal")
        if (row.state !== "ready" || !row.journal.source)
          return yield* fail(
            row.state === "waiting_boundary" ? "WAITING_BOUNDARY" : "RECOVERY_REQUIRED",
            "Plan edit is not ready for a candidate",
          )
        const goal = yield* requireCurrent(tx, row, authorize)
        if (
          row.revision !== input.expectedEditRevision ||
          goal.revision !== input.expectedControlRevision ||
          goal.plan_revision !== input.expectedPlanRevision ||
          row.journal.source.planDocVersion !== input.expectedDocVersion ||
          row.journal.source.planDocHash !== input.expectedDocHash
        )
          return yield* fail("REVISION_CONFLICT", "Plan edit expected source revision or hash changed")
        const prepared = yield* Effect.try({
          try: () => {
            requireDocuments(row, directory, false)
            const plan = { ...validateCandidate(row.journal.source!, input.candidate), replan_reason: input.reason }
            const planDoc = row.journal.source!.documents.find((item) => item.id === goal.plan_doc_id)!
            const target = { ...planDoc, version: planDoc.version + 1, body: canonical(plan) }
            if (Buffer.byteLength(target.body) > 65536 || !DeepAgentPlanStore.decodePlanDoc(target.body))
              throw fail("CAPACITY", "Edited plan exceeds its supported exact document budget")
            const lineage: GoalTickProgram.PlanLineage = {
              version: 1,
              planRevision: row.target_plan_revision,
              rebaseID: row.edit_id,
              sourceReceiptHash: row.journal.source!.receiptHash,
              planDocID: target.id,
              planDocVersion: target.version,
              planDocHash: hash(target),
              baselineDocsHash: row.journal.source!.baselineDocsHash,
            }
            const runtimeDoc = row.journal.source!.documents.find(
              (item) => item.id === `doc:run_context:${goal.goal_id}`,
            )
            if (!runtimeDoc) throw fail("RECOVERY_REQUIRED", "Goal complete runtime source is unavailable")
            const runtime = GoalTickState.requireState(
              Schema.decodeUnknownSync(Schema.fromJsonString(GoalTickState.Runtime))(runtimeDoc.body),
            )
            if (
              runtime.ledger.ticks !== goal.next_seq ||
              runtime.goalId !== goal.goal_id ||
              runtime.sessionId !== goal.session_id ||
              canonical(runtime.spec) !== canonical(goal.initialization.spec)
            )
              throw fail("RECOVERY_REQUIRED", "Goal runtime does not match the settled edit boundary")
            const next = GoalTickState.requireState({
              ...runtime,
              version: 3,
              planLineage: lineage,
              phase: "running",
              stallCount: 0,
              lastFingerprint: null,
              lastProcessedVersion: target.version,
            })
            const nextState = canonical(next)
            const history = canonical({
              version: 1,
              kind: "plan_rebase",
              editID: row.edit_id,
              sourceReceiptHash: row.journal.source!.receiptHash,
              candidateHash: hash(input.candidate),
              reason: input.reason,
              dispositions: input.candidate.dispositions,
              previousStallCount: runtime.stallCount,
              fromPlanRevision: row.source_plan_revision,
              toPlanRevision: row.target_plan_revision,
            })
            const documents = row.journal.source!.documents.map(
              (document): typeof GoalTickProgram.FullDocument.Type => {
                const payload =
                  document.id === target.id
                    ? target
                    : document.id === runtimeDoc.id
                      ? { ...document, version: document.version + 1, body: nextState }
                      : document.type === "worklog"
                        ? { ...document, version: document.version + 1, body: `${document.body}\n${history}\n` }
                        : document
                if (Buffer.byteLength(payload.body) > (document.type === "run_context" ? 131072 : 65536))
                  throw fail("CAPACITY", "Edited document exceeds its reserved body budget")
                return {
                  documentID: document.id,
                  expectedVersion: document.version,
                  expectedHash: hash(document),
                  payload: canonical(payload),
                  payloadHash: hash(canonical(payload)),
                  state: "pending",
                  observedVersion: null,
                  observedHash: null,
                }
              },
            )
            const worst = {
              ...receipt(row, goal, command),
              requestID: "r".repeat(128),
              action: "reconcile" as const,
              revision: Number.MAX_SAFE_INTEGER,
              sourcePlanRevision: Number.MAX_SAFE_INTEGER,
              sourceControlRevision: Number.MAX_SAFE_INTEGER,
              targetPlanRevision: Number.MAX_SAFE_INTEGER,
              controlRevision: Number.MAX_SAFE_INTEGER,
              planDocVersion: Number.MAX_SAFE_INTEGER,
              nextSeq: Number.MAX_SAFE_INTEGER,
              recordedAt: Number.MAX_SAFE_INTEGER,
              sourceReceiptHash: "f".repeat(64),
              candidateHash: "f".repeat(64),
              committedReceiptHash: "f".repeat(64),
              planDocHash: "f".repeat(64),
              state: "recovery_required" as const,
              execution: "waiting_boundary" as const,
              confirmedDocuments: documents.length,
              totalDocuments: documents.length,
              projections: documents.map((item) => ({
                documentID: item.documentID,
                state: "confirmed" as const,
                version: Number.MAX_SAFE_INTEGER,
                hash: "f".repeat(64),
              })),
            }
            if (GoalTickProgram.bytes(worst) > GoalPlanRebaseSchema.RECEIPT_BYTES)
              throw fail("CAPACITY", "Plan edit cannot reserve its complete worst-case terminal receipt")
            return { documents, nextState, commands: append(row, command) }
          },
          catch: (error) =>
            error instanceof GoalPlanRebaseSchema.Error
              ? error
              : fail("INVALID_CANDIDATE", "Candidate could not be prepared from the exact source"),
        })
        yield* register(tx, goal, command)
        const updated = yield* write(
          tx,
          row,
          { ...row.journal, ...prepared, candidateHash: hash(input.candidate), preparedAt: Date.now() },
          "prepared",
        )
        return { row: updated, replayed: false }
      }),
    { behavior: "immediate" },
  ).pipe(GoalChildResult.withRuntimeIdentity(db))

export const project = (db: Db, editID: string, documentID: string, directory: string, authorize: Authority) =>
  Effect.gen(function* () {
    // This transaction must commit before the first file effect; a killed process never proves zero effects from RAM.
    yield* db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const row = yield* read(tx, editID)
          if (!row || !["prepared", "mirror_pending"].includes(row.state))
            return yield* fail("RECOVERY_REQUIRED", "Plan edit has no prepared projection")
          yield* requireCurrent(tx, row, authorize)
          if (!row.journal.documents.some((item) => item.documentID === documentID))
            return yield* fail("TARGET_CONFLICT", "Document is outside the prepared edit")
          if (!row.journal.fileStarted) yield* write(tx, row, { ...row.journal, fileStarted: true }, row.state)
        }),
      { behavior: "immediate" },
    ).pipe(GoalChildResult.withRuntimeIdentity(db))
    return yield* db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const row = yield* read(tx, editID)
          if (!row || !["prepared", "mirror_pending"].includes(row.state))
            return yield* fail("RECOVERY_REQUIRED", "Plan edit has no projectable frozen candidate")
          yield* requireCurrent(tx, row, authorize)
          const mirror = row.journal.documents.find((item) => item.documentID === documentID)
          if (!mirror) return yield* fail("TARGET_CONFLICT", "Document is outside the frozen edit set")
          const observed = yield* Effect.try({
            try: () => {
              requireDocuments(row, directory, true)
              const store = DocumentStore.openExactForCreate(
                directory,
                row.journal.documents.map((item) => item.documentID),
              )
              const payload = Schema.decodeUnknownSync(Schema.fromJsonString(GoalTickProgram.DocumentPayload))(
                mirror.payload,
              )
              const actual = store.get(documentID)
              // Unchanged source documents need confirmation, not a fabricated version increment.
              const result =
                actual &&
                canonical(Object.fromEntries(Object.entries(actual).filter(([key]) => key !== "hash"))) ===
                  mirror.payload
                  ? actual
                  : store.projectExact(payload, {
                      id: documentID,
                      version: mirror.expectedVersion!,
                      hash: `sha256:${mirror.expectedHash}`,
                    })
              const readback = DocumentStore.openExact(directory, [documentID]).get(documentID)
              if (
                !readback ||
                readback.hash !== result.hash ||
                readback.version !== result.version ||
                canonical(Object.fromEntries(Object.entries(readback).filter(([key]) => key !== "hash"))) !==
                  mirror.payload
              )
                throw fail("PLAN_CONFLICT", "Plan edit file readback differs from its frozen payload")
              return { version: result.version, hash: result.hash.slice(7) }
            },
            catch: (error) =>
              error instanceof GoalPlanRebaseSchema.Error
                ? error
                : fail("RECOVERY_REQUIRED", "Exact plan edit file effect is unconfirmed; reconcile the same payload"),
          })
          if (mirror.state === "confirmed") {
            if (mirror.observedVersion !== observed.version || mirror.observedHash !== observed.hash)
              return yield* fail("PLAN_CONFLICT", "Confirmed plan edit projection changed")
            return row
          }
          return yield* write(
            tx,
            row,
            {
              ...row.journal,
              documents: row.journal.documents.map((item) =>
                item.documentID === documentID
                  ? { ...item, state: "confirmed", observedVersion: observed.version, observedHash: observed.hash }
                  : item,
              ),
            },
            "mirror_pending",
          )
        }),
      { behavior: "immediate" },
    ).pipe(GoalChildResult.withRuntimeIdentity(db))
  })

export const settle = (db: Db, editID: string, directory: string, authorize: Authority) =>
  db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const row = yield* read(tx, editID)
        if (!row) return yield* fail("NOT_FOUND", "Plan edit does not exist")
        yield* authorize(tx, row.session_id, row.goal_id)
        if (row.state === "committed") return row
        const goal = yield* requireCurrent(tx, row, authorize)
        if (
          row.state !== "mirror_pending" ||
          !row.journal.nextState ||
          !row.journal.documents.length ||
          row.journal.documents.some((item) => item.state !== "confirmed")
        )
          return yield* fail("RECOVERY_REQUIRED", "Plan edit is not completely projected")
        yield* Effect.try({
          try: () => {
            requireDocuments(row, directory, true)
            const store = DocumentStore.openExact(
              directory,
              row.journal.documents.map((item) => item.documentID),
            )
            if (
              row.journal.documents.some((item) => {
                const actual = store.get(item.documentID)
                return (
                  !actual || actual.hash !== `sha256:${item.observedHash}` || actual.version !== item.observedVersion
                )
              })
            )
              throw fail("PLAN_CONFLICT", "Final plan edit readback changed")
          },
          catch: () => fail("PLAN_CONFLICT", "Final plan edit readback changed"),
        })
        const committedAt = Date.now()
        const committedReceiptHash = hash({
          editID: row.edit_id,
          source: row.source_receipt_hash,
          candidate: row.journal.candidateHash,
          sourcePlanRevision: row.source_plan_revision,
          targetPlanRevision: row.target_plan_revision,
          nextSeq: goal.next_seq,
          documents: row.journal.documents,
          nextState: hash(row.journal.nextState),
          preparedAt: row.journal.preparedAt,
          committedAt,
        })
        const plan = row.journal.documents.find((item) => item.documentID === goal.plan_doc_id)!
        const changed = yield* tx
          .update(GoalControlTable)
          .set({
            plan_revision: row.target_plan_revision,
            plan_rebase_id: row.edit_id,
            pending_rebase_id: null,
            revision: goal.revision + 1,
            plan_version: plan.observedVersion!,
            requested_phase: goal.requested_phase === "stopped" ? "stopped" : "paused",
            updated_at: committedAt,
          })
          .where(eq(GoalControlTable.goal_id, goal.goal_id))
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (!changed) return yield* fail("UNAVAILABLE", "Plan edit control commit failed")
        const committed = {
          ...row,
          state: "committed" as const,
          revision: row.revision + 1,
          journal: { ...row.journal, committedAt, committedReceiptHash },
        }
        return yield* write(
          tx,
          row,
          {
            ...committed.journal,
            commands: row.journal.commands.map((item) =>
              item.receipt !== null ? item : { ...item, receipt: receipt(committed, changed, item.command) },
            ),
          },
          "committed",
        )
      }),
    { behavior: "immediate" },
  ).pipe(GoalChildResult.withRuntimeIdentity(db))

export const cancel = (db: Db, input: GoalPlanRebaseSchema.Target, authorize: Authority) =>
  db.transaction(
    (tx) =>
      Effect.gen(function* () {
        yield* decode(GoalPlanRebaseSchema.Target, input)
        yield* authorize(tx, input.sessionID, input.goalID)
        const command = { action: "cancel", request: input } as const
        const prior = yield* historical(tx, command)
        if (prior) return yield* response(tx, prior, input.requestID, true, authorize)
        const row = yield* read(tx, input.editID)
        if (!row || row.goal_id !== input.goalID || row.session_id !== input.sessionID)
          return yield* fail("NOT_FOUND", "Plan edit target is unavailable")
        const goal =
          row.state === "waiting_boundary"
            ? yield* GoalControl.requireTarget(tx, row.goal_id, row.session_id)
            : yield* requireCurrent(tx, row, authorize)
        if (!["waiting_boundary", "ready", "prepared"].includes(row.state) || row.journal.fileStarted)
          return yield* fail("RECOVERY_REQUIRED", "Only an edit before the durable first-file marker can be cancelled")
        if (
          row.revision !== input.expectedEditRevision ||
          goal.revision !== input.expectedControlRevision ||
          goal.revision !== row.expected_control_revision ||
          goal.pending_rebase_id !== row.edit_id ||
          goal.plan_revision !== row.source_plan_revision
        )
          return yield* fail("REVISION_CONFLICT", "Plan edit cancel revision changed")
        const commands = yield* Effect.try({
          try: () => append(row, command),
          catch: () => fail("CAPACITY", "No cancellation receipt slot remains"),
        })
        const changed = yield* tx
          .update(GoalControlTable)
          .set({
            pending_rebase_id: null,
            revision: goal.revision + 1,
            requested_phase: "paused",
            updated_at: Date.now(),
          })
          .where(eq(GoalControlTable.goal_id, goal.goal_id))
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (!changed) return yield* fail("UNAVAILABLE", "Plan edit cancellation failed")
        yield* register(tx, changed, command)
        const cancelled = { ...row, state: "cancelled" as const, revision: row.revision + 1 }
        const updated = yield* write(
          tx,
          row,
          {
            ...row.journal,
            commands: commands.map((item) =>
              item.receipt ? item : { ...item, receipt: receipt(cancelled, changed, item.command) },
            ),
          },
          "cancelled",
        )
        return yield* response(tx, updated, input.requestID, false, authorize)
      }),
    { behavior: "immediate" },
  ).pipe(GoalChildResult.withRuntimeIdentity(db))

export const reconcile = (db: Db, input: GoalPlanRebaseSchema.Target, authorize: Authority) =>
  db.transaction(
    (tx) =>
      Effect.gen(function* () {
        yield* decode(GoalPlanRebaseSchema.Target, input)
        yield* authorize(tx, input.sessionID, input.goalID)
        const command = { action: "reconcile", request: input } as const
        const prior = yield* historical(tx, command)
        if (prior) {
          if (prior.state !== "recovery_required" || !prior.journal.controlInterruption)
            return { row: prior, replayed: true }
          yield* requireCurrent(tx, prior, authorize)
          return { row: yield* write(tx, prior, prior.journal, "prepared"), replayed: true }
        }
        const row = yield* read(tx, input.editID)
        if (!row || row.goal_id !== input.goalID || row.session_id !== input.sessionID)
          return yield* fail("NOT_FOUND", "Plan edit target is unavailable")
        const goal = yield* requireCurrent(tx, row, authorize)
        if (
          !["prepared", "mirror_pending", "recovery_required"].includes(row.state) ||
          row.journal.nextState === null ||
          (row.state === "recovery_required" && !row.journal.controlInterruption)
        )
          return yield* fail("RECOVERY_REQUIRED", "No frozen candidate can be reconciled")
        if (row.revision !== input.expectedEditRevision || goal.revision !== input.expectedControlRevision)
          return yield* fail("REVISION_CONFLICT", "Plan edit reconcile revision changed")
        const commands = yield* Effect.try({
          try: () => append(row, command),
          catch: () => fail("CAPACITY", "No recovery receipt slot remains; reuse the pending requestID"),
        })
        yield* register(tx, goal, command)
        return {
          row: yield* write(
            tx,
            row,
            { ...row.journal, commands },
            row.state === "recovery_required" ? "prepared" : row.state,
          ),
          replayed: false,
        }
      }),
    { behavior: "immediate" },
  ).pipe(GoalChildResult.withRuntimeIdentity(db))
