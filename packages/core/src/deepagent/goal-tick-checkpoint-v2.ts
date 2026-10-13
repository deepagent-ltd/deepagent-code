export * as GoalTickCheckpointV2 from "./goal-tick-checkpoint-v2"

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm"
import { Cause, Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { EventSequenceTable } from "../event/sql"
import { Prompt } from "../session/prompt"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { SessionSteerTable } from "../session/sql"
import { GoalControl } from "./goal-control"
import { GoalTickPermitTable } from "./goal-control.sql"
import { GoalTickCheckpoint } from "./goal-tick-checkpoint"
import { GoalTickCheckpointSchema } from "./goal-tick-checkpoint.schema"
import { GoalTickCheckpointTable } from "./goal-tick-checkpoint.sql"
import { GoalTickProgram } from "./goal-tick-program"
import { GoalChild } from "./goal-child"
import { GoalChildResult } from "./goal-child-result"
import { GoalChildUnitTable } from "./goal-child.sql"
import { DocumentStore } from "./document-store"
import { GoalTickState } from "./goal-tick-state"
import { GoalPlanRebase } from "./goal-plan-rebase"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"

type Db = Database.Interface["db"]
type Reader = GoalTickCheckpoint.Reader
export type Row = Omit<typeof GoalTickCheckpointTable.$inferSelect, "journal"> & {
  readonly journal: GoalTickProgram.Journal
}
const fail = (code: GoalTickCheckpointSchema.Error["code"], message: string) =>
  new GoalTickCheckpointSchema.Error({ code, message })
const validate = (journal: GoalTickProgram.Journal) =>
  Effect.try({
    try: () => GoalTickProgram.validateJournal(journal),
    catch: () => fail("CHECKPOINT_INVALID", "Version 2 journal does not satisfy its immutable program"),
  })
const permitBinding = (permit: typeof GoalTickPermitTable.$inferSelect) => ({
  id: permit.permit_id,
  token: permit.token,
  goalID: permit.goal_id,
  tickSeq: permit.tick_seq,
  controlRevision: permit.control_revision,
  planVersion: permit.plan_version,
  ownerID: permit.owner_id,
})

/** Decode and reconcile immutable bindings. Reading never creates a live policy or execution owner. */
export const read = (db: Reader, permitID: string) =>
  Effect.gen(function* () {
    const size = yield* db.get<{ bytes: number; logical: number; reserved: number }>(sql`
      SELECT length(CAST(journal AS BLOB)) AS bytes,logical_bytes AS logical,reserved_bytes AS reserved
      FROM goal_tick_checkpoint WHERE permit_id=${permitID}`).pipe(Effect.orDie)
    if (!size) return undefined
    if (!Number.isSafeInteger(size.bytes) || size.bytes < 1 || size.bytes > GoalTickProgram.MAX_BYTES ||
        size.logical !== size.bytes || size.reserved < size.bytes || size.reserved > GoalTickProgram.MAX_BYTES)
      return yield* fail("CHECKPOINT_RECOVERY_REQUIRED", "Checkpoint exceeds its encoded storage boundary")
    const row = yield* db
      .select()
      .from(GoalTickCheckpointTable)
      .where(eq(GoalTickCheckpointTable.permit_id, permitID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return undefined
    if (row.version !== 2 && row.version !== 3)
      return yield* fail("CHECKPOINT_INVALID", "Version 2 operation cannot reinterpret an old journal")
    const decoded = Schema.decodeUnknownOption(GoalTickProgram.Journal, { onExcessProperty: "error" })(row.journal)
    if (Option.isNone(decoded)) return yield* fail("CHECKPOINT_INVALID", "Version 2 journal is malformed")
    const journal = decoded.value
    yield* validate(journal)
    const goal = yield* GoalControl.get(db, row.goal_id)
    const permit = yield* db
      .select()
      .from(GoalTickPermitTable)
      .where(eq(GoalTickPermitTable.permit_id, permitID))
      .get()
      .pipe(Effect.orDie)
    if (
      row.version !== journal.version ||
      !goal ||
      !permit ||
      permit.goal_id !== row.goal_id ||
      permit.tick_seq !== row.tick_seq ||
      goal.session_id !== journal.parent.sessionID ||
      row.binding_hash !==
        GoalControl.fingerprint({
          parent: journal.parent,
          program: journal.program,
          permit: permitBinding(permit),
          initializationHash: goal.initialization_hash,
        }) ||
      row.role_manifest_hash !== GoalTickProgram.hash(journal.program) ||
      row.journal_hash !== GoalControl.fingerprint(row.journal) ||
      row.logical_bytes !== Buffer.byteLength(JSON.stringify(row.journal)) ||
      row.reserved_bytes < row.logical_bytes ||
      row.parent_checked_through_seq < journal.parent.sourceSeq ||
      !Schema.is(GoalTickCheckpointSchema.State)(row.state)
    )
      return yield* fail("CHECKPOINT_RECOVERY_REQUIRED", "Version 2 checkpoint binding is inconsistent")
    for (const activation of journal.activations) {
      const role = journal.program.roles[activation.role]
      if (
        activation.unitID !== `goalchild_${GoalControl.fingerprint([permitID, role.key])}` ||
        activation.recipeHash !== role.recipe.hash ||
        GoalControl.fingerprint(activation.dependencies) !==
          GoalControl.fingerprint(dependencies(journal, activation.role))
      )
        return yield* fail(
          "CHECKPOINT_RECOVERY_REQUIRED",
          "Activated role does not match its stable source dependencies",
        )
    }
    for (const disposition of journal.dispositions) {
      if (disposition.kind !== "completed") {
        if (
          GoalControl.fingerprint(disposition.evidence) !==
          GoalControl.fingerprint(dependencies(journal, disposition.role))
        )
          return yield* fail("CHECKPOINT_RECOVERY_REQUIRED", "Skipped role predecessor facts changed")
        continue
      }
      const activation = journal.activations.find((item) => item.role === disposition.role)!
      const result = journal.results.filter((item) => item.unitID === activation.unitID).at(-1)!
      if (
        GoalControl.fingerprint(disposition.evidence) !==
        GoalControl.fingerprint({
          count: 1,
          through: result.admittedSeq,
          hash: GoalControl.fingerprint(result),
        })
      )
        return yield* fail("CHECKPOINT_RECOVERY_REQUIRED", "Completed role disposition has a different result")
    }
    return { ...row, journal }
  })

export const requireParent = (db: Reader, row: Row) =>
  GoalTickCheckpoint.currentPermit(db, row.permit_id).pipe(
    Effect.flatMap(() => GoalTickCheckpoint.requireParentFacts(db, row)),
  )

export const begin = (db: Db, input: { permitID: string; permitToken: string; program: GoalTickProgram.Program }) =>
  db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const source = yield* GoalTickCheckpoint.currentPermit(tx, input.permitID, input.permitToken)
        const prior = yield* read(tx, input.permitID)
        if (prior) {
          if (GoalTickProgram.hash(input.program) !== prior.journal.programHash)
            return yield* fail("CHECKPOINT_CONFLICT", "Tick program was frozen differently")
          yield* requireParent(tx, prior)
          return prior
        }
        if (input.program.version === 3) {
          const baseline = yield* GoalPlanRebase.baseline(tx, source.goal)
          const plan = baseline.documents.find((item) => item.id === source.goal.plan_doc_id)
          if (!plan || GoalTickProgram.hash(input.program.planLineage) !== GoalTickProgram.hash({
            version: 1, planRevision: source.goal.plan_revision, rebaseID: source.goal.plan_rebase_id,
            sourceReceiptHash: baseline.receiptHash, planDocID: plan.id, planDocVersion: plan.version,
            planDocHash: GoalTickProgram.hash(plan), baselineDocsHash: GoalTickProgram.hash(baseline.documents),
          })) return yield* fail("CHECKPOINT_CONFLICT", "Program lineage differs from its actual committed source")
        } else if (source.goal.plan_revision > 0) {
          return yield* fail("CHECKPOINT_CONFLICT", "A rebased Goal requires a versioned lineage program")
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
        if (steers.length > 256) return yield* fail("CHECKPOINT_CAPACITY", "Goal steering exceeds its bounded capacity")
        if (steers.some((row) => !plainSteer(row.prompt)))
          return yield* fail("CHECKPOINT_INVALID", "Goal steering contains a field unsupported by this text recipe")
        if (Buffer.byteLength(JSON.stringify(steers.map((row) => row.prompt.text))) > 32768)
          return yield* fail("CHECKPOINT_CAPACITY", "Frozen Goal steering exceeds its encoded text budget")
        const journal = yield* Effect.try({
          try: () =>
            GoalTickProgram.reservation(input.program, {
              sessionID: parent.id,
              sourceSeq: sequence.seq,
              authorityHash: GoalControl.fingerprint(GoalTickCheckpoint.authority(parent)),
              authority: GoalTickCheckpoint.canonical(GoalTickCheckpoint.authority(parent)),
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
            }).empty,
          catch: () => fail("CHECKPOINT_CAPACITY", "Program cannot fit its pre-execution reservation"),
        })
        yield* validate(journal)
        const capacity = yield* tx
          .get<{
            records: number
            bytes: number
          }>(sql`SELECT count(*) AS records,coalesce(sum(reserved_bytes),0) AS bytes FROM goal_tick_checkpoint`)
          .pipe(Effect.orDie)
        if (
          !capacity ||
          capacity.records >= GoalTickCheckpointSchema.MAX_RECORDS ||
          capacity.bytes + GoalTickProgram.MAX_BYTES > GoalTickCheckpointSchema.MAX_INSTANCE_BYTES
        )
          return yield* fail("CHECKPOINT_CAPACITY", "Checkpoint storage capacity is exhausted")
        const now = Date.now()
        yield* tx
          .insert(GoalTickCheckpointTable)
          .values({
            permit_id: input.permitID,
            goal_id: source.goal.goal_id,
            tick_seq: source.permit.tick_seq,
            version: journal.version,
            revision: 0,
            binding_hash: GoalControl.fingerprint({
              parent: journal.parent,
              program: journal.program,
              permit: permitBinding(source.permit),
              initializationHash: source.goal.initialization_hash,
            }),
            role_manifest_hash: journal.programHash,
            parent_checked_through_seq: sequence.seq,
            state: "prepared",
            journal,
            journal_hash: GoalControl.fingerprint(journal),
            logical_bytes: Buffer.byteLength(JSON.stringify(journal)),
            reserved_bytes: GoalTickProgram.MAX_BYTES,
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

/** The trusted recipe caller supplies actual prompt bytes once. Admission later checks this exact hash. */
export const activate = (db: Db, input: { permitID: string; revision: number; role: number; text: string }) =>
  db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const row = yield* read(tx, input.permitID)
        if (!row || row.revision !== input.revision || row.journal.cursor.role !== input.role)
          return yield* fail("CHECKPOINT_CONFLICT", "Role activation is outside the current cursor")
        yield* requireParent(tx, row)
        yield* GoalChildResult.inspectMany(tx, row.journal.results)
        const role = row.journal.program.roles[input.role]
        if (
          !role ||
          Buffer.byteLength(input.text) > 262144 ||
          role.recipe.dependencies.some((index) => !row.journal.dispositions.some((item) => item.role === index))
        )
          return yield* fail("CHECKPOINT_CONFLICT", "Role has unproven predecessor decisions")
        const promptHash = GoalControl.fingerprint(new Prompt({ text: input.text }))
        const existing = row.journal.activations.find((item) => item.role === input.role)
        if (existing) {
          if (existing.promptHash !== promptHash)
            return yield* fail("CHECKPOINT_CONFLICT", "Activated prompt cannot change")
          return row
        }
        const unitID = `goalchild_${GoalControl.fingerprint([row.permit_id, role.key])}`
        const activation: GoalTickProgram.Activation = {
          role: input.role,
          recipeHash: role.recipe.hash,
          dependencies: dependencies(row.journal, input.role),
          promptHash,
          unitID,
          inputID: `msg_goalchild_${GoalControl.fingerprint([unitID, role.mode === "plain" ? "plain" : "research"]).slice(0, 40)}`,
          activatedAt: Date.now(),
        }
        return yield* write(
          tx,
          row,
          { ...row.journal, activations: [...row.journal.activations, activation] },
          "running",
        )
      }),
    { behavior: "immediate" },
  )

export function dependencies(journal: GoalTickProgram.Journal, roleIndex: number) {
  const indices = journal.program.roles[roleIndex].recipe.dependencies
  const units = new Set(journal.activations.filter((item) => indices.includes(item.role)).map((item) => item.unitID))
  const results = journal.results.filter((item) => units.has(item.unitID))
  const dispositions = journal.dispositions.filter((item) => indices.includes(item.role))
  return {
    count: results.length,
    through: results.reduce((max, item) => Math.max(max, item.admittedSeq), 0),
    hash: GoalControl.fingerprint({ results, dispositions }),
  }
}

const write = (
  db: Reader,
  row: Row,
  journal: GoalTickProgram.Journal,
  state: GoalTickCheckpointSchema.State,
  errorCode: string | null = null,
) =>
  Effect.gen(function* () {
    yield* validate(journal)
    if (
      GoalTickProgram.hash(journal.program) !== row.journal.programHash ||
      GoalControl.fingerprint(journal.parent) !== GoalControl.fingerprint(row.journal.parent)
    )
      return yield* fail("CHECKPOINT_CONFLICT", "Immutable tick source changed")
    const bytes = Buffer.byteLength(JSON.stringify(journal))
    const changed = yield* db
      .update(GoalTickCheckpointTable)
      .set({
        journal,
        journal_hash: GoalControl.fingerprint(journal),
        logical_bytes: bytes,
        reserved_bytes: state === "committed" || state === "halted" ? bytes : row.reserved_bytes,
        state,
        revision: row.revision + 1,
        error_code: errorCode,
        updated_at: Date.now(),
      })
      .where(
        and(
          eq(GoalTickCheckpointTable.permit_id, row.permit_id),
          eq(GoalTickCheckpointTable.revision, row.revision),
          eq(GoalTickCheckpointTable.journal_hash, row.journal_hash),
        ),
      )
      .returning({ id: GoalTickCheckpointTable.permit_id })
      .all()
      .pipe(Effect.orDie)
    if (changed.length !== 1) return yield* fail("CHECKPOINT_CONFLICT", "Checkpoint compare-and-swap lost")
    return (yield* read(db, row.permit_id))!
  })

export const recordResult = (db: Db, proof: GoalChildResult.Proof) =>
  db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const facts = yield* GoalChildResult.recheck(tx, proof)
        const unit = (yield* GoalChild.read(tx, facts.result.unitID))!
        const row = yield* read(tx, unit.permit_id)
        if (!row || unit.binding.version !== 3 || unit.binding.policy.checkpointHash !== row.binding_hash)
          return yield* fail("CHECKPOINT_CONFLICT", "Result does not belong to this versioned program")
        const existing = row.journal.results.find((item) => item.inputID === facts.result.inputID)
        if (existing) {
          if (GoalControl.fingerprint(existing) !== GoalControl.fingerprint(facts.result))
            return yield* fail("CHECKPOINT_CONFLICT", "Goal stage has a different result")
          return row
        }
        const activation = row.journal.activations.find((item) => item.unitID === unit.unit_id)
        if (!activation || activation.role !== row.journal.cursor.role)
          return yield* fail("CHECKPOINT_CONFLICT", "Result has no exact current activation")
        const current = yield* requireParent(tx, row).pipe(Effect.exit)
        if (current._tag === "Failure" && Cause.hasInterrupts(current.cause))
          return yield* Effect.failCause(current.cause)
        const results = [...row.journal.results, facts.result]
        const nextStage =
          facts.result.stage === "research"
            ? "finalizer.1"
            : facts.result.stage === "finalizer.1" && facts.result.outcome === "schema_invalid"
              ? "finalizer.2"
              : undefined
        const dispositions: GoalTickProgram.Journal["dispositions"] = nextStage
          ? row.journal.dispositions
          : [
              ...row.journal.dispositions,
              {
                role: activation.role,
                kind: "completed",
                rule: "actual-result-v2",
                evidence: { count: 1, through: facts.result.admittedSeq, hash: GoalControl.fingerprint(facts.result) },
              },
            ]
        const cursor = nextStage
          ? { role: activation.role, stage: nextStage }
          : {
              role: activation.role + 1,
              stage: row.journal.program.roles[activation.role + 1]?.mode === "structured" ? "research" : "plain",
            }
        const changed = yield* tx
          .update(GoalChildUnitTable)
          .set({
            state: nextStage ? "admitted" : "result_recorded",
            inputs: unit.inputs.map((item) =>
              item.stage === facts.result.stage
                ? {
                    ...item,
                    resultRef: facts.result.messageID,
                    resultHash: facts.result.resultHash,
                  }
                : item,
            ),
            updated_at: Date.now(),
          })
          .where(
            and(eq(GoalChildUnitTable.unit_id, unit.unit_id), eq(GoalChildUnitTable.binding_hash, facts.bindingHash)),
          )
          .returning({ id: GoalChildUnitTable.unit_id })
          .all()
          .pipe(Effect.orDie)
        if (changed.length !== 1) return yield* fail("CHECKPOINT_CONFLICT", "Result receipt compare-and-swap lost")
        return yield* write(
          tx,
          row,
          {
            ...row.journal,
            results,
            dispositions,
            cursor: Schema.decodeUnknownSync(GoalTickCheckpointSchema.Cursor)(cursor),
          },
          current._tag === "Success" ? "running" : "recovery_required",
          current._tag === "Success" ? null : "CHECKPOINT_CONTROL_CHANGED",
        )
      }),
    { behavior: "immediate" },
  )

/** Unknown state is a retained tombstone; this never clears an input, result or storage reservation. */
export const markUnknown = (db: Db, permitID: string) =>
  db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const row = yield* read(tx, permitID)
        if (!row || ["committed", "halted", "recovery_required"].includes(row.state)) return row
        return yield* write(tx, row, row.journal, "recovery_required", "CHECKPOINT_RECOVERY_REQUIRED")
      }),
    { behavior: "immediate" },
  )

/** Internal native controller seam. The host inspector accepts only its live private witness,
 * captured after the actual grader or arbiter. A skipped role never gets an input or a result. */
export function controllerAuthority<Witness>(
  inspect: (witness: Witness) =>
    | {
        readonly permitID: string
        readonly journalHash: string
        readonly roles: readonly number[]
        readonly rule: "cheap-gate-v2" | "panel-converged-v2" | "terminal-decision-v2"
      }
    | undefined,
) {
  return (db: Db, witness: Witness) =>
    db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const observed = inspect(witness)
          if (!observed) return yield* fail("CHECKPOINT_CONFLICT", "Live controller decision is unavailable")
          const row = yield* read(tx, observed.permitID)
          if (!row || row.journal_hash !== observed.journalHash || !["prepared", "running"].includes(row.state))
            return yield* fail("CHECKPOINT_CONFLICT", "Controller decision frontier changed")
          yield* requireParent(tx, row)
          yield* GoalChildResult.inspectMany(tx, row.journal.results)
          if (
            !observed.roles.length ||
            observed.roles.some(
              (role, index) =>
                role !== row.journal.cursor.role + index ||
                !row.journal.program.roles[role] ||
                row.journal.activations.some((item) => item.role === role),
            ) ||
            row.journal.localEffects.some((item) => ["prepared", "dispatched", "unknown"].includes(item.state))
          )
            return yield* fail("CHECKPOINT_CONFLICT", "Controller cannot skip activated or unknown work")
          const dispositions = [...row.journal.dispositions]
          for (const role of observed.roles)
            dispositions.push({
              role,
              kind: "skipped",
              rule: observed.rule,
              evidence: dependencies({ ...row.journal, dispositions }, role),
            })
          const role = observed.roles.at(-1)! + 1
          const stage =
            row.journal.program.roles[role]?.mode === "structured" ? ("research" as const) : ("plain" as const)
          return yield* write(tx, row, { ...row.journal, dispositions, cursor: { role, stage } }, "running")
        }),
      { behavior: "immediate" },
    )
}

type NativeLocalSnapshot = Pick<
  GoalTickProgram.LocalEffect,
  "commandHash" | "cwdHash" | "profileHash" | "instanceID" | "handleID" | "containment"
>
type NativeLocalResult = Omit<GoalTickProgram.LocalEffect, "version" | "id" | "kind">

/** Trusted host installation seam. Callers never submit a result DTO: the captured native adapter
 * re-reads its private handle/receipt. This factory is internal and is not exposed through an API. */
export function localEffectAuthority<Handle>(native: {
  snapshot: (handle: Handle) => NativeLocalSnapshot | undefined
  inspect: (handle: Handle) => NativeLocalResult | undefined
}) {
  const source = (db: Reader, row: Row, ordinal: number, handle: Handle) =>
    Effect.gen(function* () {
      const goal = yield* GoalControl.get(db, row.goal_id)
      const commands =
        goal?.initialization.spec.criteria.flatMap((criterion) =>
          criterion.kind === "tests_pass" ? criterion.commands : [],
        ) ?? []
      const snapshot = native.snapshot(handle)
      const command = commands[ordinal]
      if (
        !snapshot ||
        snapshot.containment !== "single-process" ||
        !Number.isSafeInteger(ordinal) ||
        ordinal < 0 ||
        ordinal >= 32 ||
        command === undefined ||
        ordinal >= row.journal.program.localEffectSlots ||
        snapshot.commandHash !== Hash.sha256(CanonicalJson.stringify({ transport: "posix", script: command })) ||
        snapshot.cwdHash !== Hash.sha256(goal!.directory)
      )
        return yield* fail("CHECKPOINT_CONFLICT", "Validation handle differs from its frozen command or placement")
      return { snapshot, id: `goaleffect_${GoalControl.fingerprint([row.permit_id, "validation", ordinal])}` }
    })
  return {
    prepare: (db: Db, input: { permitID: string; ordinal: number; handle: Handle }) =>
      db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const row = yield* read(tx, input.permitID)
            if (!row || !["prepared", "running"].includes(row.state))
              return yield* fail("CHECKPOINT_CONFLICT", "Tick cannot prepare validation")
            yield* requireParent(tx, row)
            const proof = yield* source(tx, row, input.ordinal, input.handle)
            if (row.journal.localEffects.some((item) => item.id === proof.id))
              return yield* fail(
                "CHECKPOINT_RECOVERY_REQUIRED",
                "Validation already has a physical-dispatch obligation",
              )
            const value: GoalTickProgram.LocalEffect = {
              ...proof.snapshot,
              id: proof.id,
              version: 2,
              kind: "validation",
              state: "prepared",
              outcome: null,
              stopProof: "not_requested",
              exitCode: null,
              signal: null,
              stdout: null,
              stderr: null,
              startedAt: 0,
              endedAt: null,
            }
            return yield* write(
              tx,
              row,
              { ...row.journal, localEffects: [...row.journal.localEffects, value] },
              "running",
            )
          }),
        { behavior: "immediate" },
      ),
    dispatch: (db: Db, input: { permitID: string; ordinal: number; handle: Handle }) =>
      db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const row = yield* read(tx, input.permitID)
            if (!row || row.state !== "running")
              return yield* fail("CHECKPOINT_CONFLICT", "Tick cannot dispatch validation")
            yield* requireParent(tx, row)
            const proof = yield* source(tx, row, input.ordinal, input.handle)
            const current = row.journal.localEffects.find((item) => item.id === proof.id)
            if (
              !current ||
              current.state !== "prepared" ||
              Object.entries(proof.snapshot).some(([key, value]) => Reflect.get(current, key) !== value)
            )
              return yield* fail("CHECKPOINT_RECOVERY_REQUIRED", "Validation dispatch was already used or replaced")
            return yield* write(
              tx,
              row,
              {
                ...row.journal,
                localEffects: row.journal.localEffects.map((item) =>
                  item.id === proof.id ? { ...item, state: "dispatched" as const } : item,
                ),
              },
              "running",
            )
          }),
        { behavior: "immediate" },
      ),
    settle: (db: Db, input: { permitID: string; ordinal: number; handle: Handle }) =>
      db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const row = yield* read(tx, input.permitID)
            if (!row) return yield* fail("CHECKPOINT_CONFLICT", "Validation journal is missing")
            const proof = yield* source(tx, row, input.ordinal, input.handle)
            const observed = native.inspect(input.handle)
            const current = row.journal.localEffects.find((item) => item.id === proof.id)
            if (
              !observed ||
              !current ||
              Object.entries(proof.snapshot).some(([key, value]) => Reflect.get(observed, key) !== value)
            )
              return yield* fail("CHECKPOINT_RECOVERY_REQUIRED", "Native validation completion is unavailable")
            const result: GoalTickProgram.LocalEffect = { ...observed, version: 2, id: proof.id, kind: "validation" }
            if (!["prepared", "dispatched"].includes(current.state)) {
              if (GoalControl.fingerprint(current) !== GoalControl.fingerprint(result))
                return yield* fail("CHECKPOINT_RECOVERY_REQUIRED", "Settled validation cannot be replaced")
              return row
            }
            if (current.state === "prepared" && result.state !== "cancelled_before_dispatch")
              return yield* fail("CHECKPOINT_RECOVERY_REQUIRED", "Native process has no durable dispatch obligation")
            const active = yield* requireParent(tx, row).pipe(Effect.exit)
            if (active._tag === "Failure" && Cause.hasInterrupts(active.cause))
              return yield* Effect.failCause(active.cause)
            return yield* write(
              tx,
              row,
              {
                ...row.journal,
                localEffects: row.journal.localEffects.map((item) => (item.id === proof.id ? result : item)),
              },
              active._tag === "Success" && result.state !== "unknown" ? "running" : "recovery_required",
              active._tag === "Success" && result.state !== "unknown" ? null : "CHECKPOINT_RECOVERY_REQUIRED",
            )
          }),
        { behavior: "immediate" },
      ),
  }
}

const requireProjection = (db: Reader, row: Row) =>
  Effect.gen(function* () {
    if (
      row.state !== "mirror_pending" ||
      row.journal.cursor.role !== row.journal.program.roles.length ||
      row.journal.localEffects.some((item) => ["prepared", "dispatched", "unknown"].includes(item.state))
    )
      return yield* fail("CHECKPOINT_RECOVERY_REQUIRED", "Projection has unsettled external work")
    const source = yield* GoalTickCheckpoint.permitAuthority(db, row.permit_id, undefined, false)
    yield* GoalTickCheckpoint.requireParentFacts(db, row)
    yield* GoalChildResult.inspectMany(db, row.journal.results)
    return source
  })

function plainSteer(prompt: Prompt) {
  return (
    prompt.text.length <= 4096 &&
    !prompt.agent &&
    !prompt.model &&
    !prompt.format &&
    !prompt.files?.length &&
    !prompt.agents?.length &&
    !prompt.references?.length
  )
}

/** A frozen cutoff only. Re-read each exact durable row; later admissions are not part of this tick. */
export const steering = (db: Reader, row: Row) =>
  Effect.gen(function* () {
    yield* GoalTickCheckpoint.requireParentFacts(db, row)
    if (!row.journal.parent.steering.rows.length) return []
    const rows = yield* db
      .select()
      .from(SessionSteerTable)
      .where(
        and(
          eq(SessionSteerTable.session_id, SessionSchema.ID.make(row.journal.parent.sessionID)),
          inArray(
            SessionSteerTable.id,
            row.journal.parent.steering.rows.map((item) => SessionMessage.ID.make(item.id)),
          ),
        ),
      )
      .orderBy(asc(SessionSteerTable.seq))
      .all()
      .pipe(Effect.orDie)
    if (rows.length !== row.journal.parent.steering.rows.length || rows.some((row) => !plainSteer(row.prompt)))
      return yield* fail("CHECKPOINT_RECOVERY_REQUIRED", "Frozen steering source is unavailable")
    return rows.map((row) => ({ id: row.id, text: row.prompt.text }))
  })

/** Called by the trusted controller, after business decisions. The actual state document and every
 * execution receipt are read here; caller-provided usage cannot replace the native ledger. */
export const prepareProjection = (
  db: Db,
  input: {
    permitID: string
    revision: number
    directory: string
    transition: GoalTickState.Transition
    documents: GoalTickProgram.Journal["documents"]
  },
) =>
  db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const row = yield* read(tx, input.permitID)
        if (
          !row ||
          row.revision !== input.revision ||
          row.journal.cursor.role !== row.journal.program.roles.length ||
          row.journal.localEffects.some((item) => ["prepared", "dispatched", "unknown"].includes(item.state))
        )
          return yield* fail("CHECKPOINT_CONFLICT", "Program has unfinished work")
        yield* requireParent(tx, row)
        yield* GoalChildResult.inspectMany(tx, row.journal.results)
        if (row.state === "mirror_pending") {
          const pending = row.journal.documents.map((item) => ({
            ...item,
            state: "pending",
            observedVersion: null,
            observedHash: null,
          }))
          if (GoalControl.fingerprint(pending) !== GoalControl.fingerprint(input.documents))
            return yield* fail("CHECKPOINT_CONFLICT", "Prepared complete document bytes cannot change")
          return row
        }
        if (
          input.documents.some(
            (item) => item.state !== "pending" || item.observedHash !== null || item.observedVersion !== null,
          ) ||
          input.documents.length !== row.journal.program.documents.length
        )
          return yield* fail("CHECKPOINT_INVALID", "Projection must contain the full exact document set")
        const stateSlot = row.journal.program.documents.find((item) => item.kind === "state")
        if (!stateSlot) return yield* fail("CHECKPOINT_INVALID", "Program has no complete runtime state slot")
        const previous = yield* Effect.try({
          try: () => {
            const store = DocumentStore.openExact(
              input.directory,
              row.journal.program.documents.map((item) => item.id),
            )
            const doc = store.get(stateSlot.id)
            if (!doc || doc.scope !== `run:${row.journal.parent.sessionID}`) throw new Error("state source")
            return { doc, state: Schema.decodeUnknownSync(Schema.fromJsonString(GoalTickState.Runtime))(doc.body) }
          },
          catch: () => fail("CHECKPOINT_RECOVERY_REQUIRED", "Current complete runtime state could not be proven"),
        })
        const source = yield* GoalTickCheckpoint.currentPermit(tx, row.permit_id)
        const expectedUsage = row.journal.results.map((item) => ({
          inputID: item.inputID,
          input: item.usage.input,
          output: item.usage.output,
          cacheRead: item.usage.cacheRead,
          cacheWrite: item.usage.cacheWrite,
          cost: null,
        }))
        if (
          GoalControl.fingerprint(input.transition.usage) !== GoalControl.fingerprint(expectedUsage) ||
          input.transition.tickSeq !== row.tick_seq ||
          previous.state.goalId !== row.goal_id ||
          previous.state.sessionId !== row.journal.parent.sessionID ||
          GoalControl.fingerprint(previous.state.spec) !== GoalControl.fingerprint(source.goal.initialization.spec) ||
          input.transition.consumedSteers.length !== row.journal.parent.steering.rows.length ||
          input.transition.consumedSteers.some((id, index) => row.journal.parent.steering.rows[index].id !== id)
        )
          return yield* fail(
            "CHECKPOINT_CONFLICT",
            "Runtime transition differs from its actual source or inclusive usage",
          )
        const frozenSteers = yield* steering(tx, row)
        const state = yield* Effect.try({
          try: () => GoalTickState.reduce(previous.state, input.transition, frozenSteers),
          catch: () => fail("CHECKPOINT_INVALID", "Runtime transition is not a valid bounded successor"),
        })
        const nextState = GoalTickProgram.canonical(state)
        const mirror = input.documents.find((item) => item.documentID === stateSlot.id)
        const payload = mirror
          ? Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(mirror.payload)
          : Option.none()
        if (
          !mirror ||
          mirror.expectedHash !== previous.doc.hash.slice(7) ||
          mirror.expectedVersion !== previous.doc.version ||
          Option.isNone(payload) ||
          typeof payload.value !== "object" ||
          payload.value === null ||
          Reflect.get(payload.value, "body") !== nextState
        )
          return yield* fail("CHECKPOINT_CONFLICT", "Complete state projection differs from the trusted reducer output")
        return yield* write(
          tx,
          row,
          { ...row.journal, documents: input.documents, nextState, nextStateHash: GoalTickProgram.hash(nextState) },
          "mirror_pending",
        )
      }),
    { behavior: "immediate" },
  )

/** File CAS is intentionally inside the short control transaction. SQL rollback cannot undo the
 * exclusive file write; the next call confirms only these same immutable bytes. */
export const projectDocument = (db: Db, input: { permitID: string; documentID: string; directory: string }) =>
  db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const row = yield* read(tx, input.permitID)
        if (!row) return yield* fail("CHECKPOINT_CONFLICT", "Prepared projection is missing")
        yield* requireProjection(tx, row)
        const mirror = row.journal.documents.find((item) => item.documentID === input.documentID)
        if (!mirror) return yield* fail("CHECKPOINT_INVALID", "Document is outside the exact prepared set")
        const observed = yield* Effect.try({
          try: () => {
            const value = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(mirror.payload)
            const store = DocumentStore.openExactForCreate(
              input.directory,
              row.journal.program.documents.map((item) => item.id),
            )
            const result = store.projectExact(
              value,
              mirror.expectedVersion === null
                ? null
                : {
                    id: mirror.documentID,
                    version: mirror.expectedVersion,
                    hash: `sha256:${mirror.expectedHash}`,
                  },
            )
            return { version: result.version, hash: result.hash.slice(7) }
          },
          catch: () => fail("CHECKPOINT_CONFLICT", "Exact full document projection could not be confirmed"),
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
            documents: row.journal.documents.map((item) =>
              item.documentID === mirror.documentID
                ? { ...item, state: "confirmed", observedVersion: observed.version, observedHash: observed.hash }
                : item,
            ),
          },
          "mirror_pending",
        )
      }),
    { behavior: "immediate" },
  )

export const settle = (db: Db, input: { permitID: string; revision: number }) =>
  db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const row = yield* read(tx, input.permitID)
        if (!row) return yield* fail("CHECKPOINT_CONFLICT", "Checkpoint is missing")
        if (row.state === "committed" && [input.revision, input.revision + 1].includes(row.revision)) return row
        if (row.revision !== input.revision || row.state === "committed")
          return yield* fail("CHECKPOINT_CONFLICT", "Settlement revision changed")
        const source = yield* requireProjection(tx, row)
        if (
          row.journal.documents.length !== row.journal.program.documents.length ||
          row.journal.documents.some((item) => item.state !== "confirmed") ||
          row.journal.nextState === null
        )
          return yield* fail("CHECKPOINT_RECOVERY_REQUIRED", "Complete projection has not been confirmed")
        const state = Schema.decodeUnknownOption(Schema.fromJsonString(GoalTickState.Runtime))(row.journal.nextState)
        if (
          Option.isNone(state) ||
          state.value.ledger.ticks !== row.tick_seq + 1 ||
          state.value.lastProcessedVersion === null ||
          state.value.goalId !== row.goal_id ||
          state.value.sessionId !== row.journal.parent.sessionID
        )
          return yield* fail("CHECKPOINT_INVALID", "Prepared runtime cursor is inconsistent")
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
            return yield* fail("CHECKPOINT_CONFLICT", "Frozen steering settlement lost its rows")
        }
        yield* GoalControl.settleTick(db, {
          permit: source.permit,
          nextSeq: state.value.ledger.ticks,
          planVersion: state.value.lastProcessedVersion,
          phase: state.value.phase,
        })
        const committed = yield* write(tx, row, row.journal, "committed")
        yield* GoalPlanRebase.readyPending(tx, row.goal_id)
        return committed
      }),
    { behavior: "immediate" },
  )
