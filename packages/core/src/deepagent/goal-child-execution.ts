export * as GoalChildExecution from "./goal-child-execution"

import { randomUUID } from "node:crypto"
import { eq, sql } from "drizzle-orm"
import { Context, Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import type { SessionRunCoordinator } from "../session/run-coordinator"
import { SessionSchema } from "../session/schema"
import { GoalChild } from "./goal-child"
import { GoalChildSchema } from "./goal-child.schema"
import { GoalChildUnitTable } from "./goal-child.sql"
import { GoalControl } from "./goal-control"
import { GoalTickCheckpointV2 } from "./goal-tick-checkpoint-v2"
import { GoalTickProgram } from "./goal-tick-program"
import { DeepAgentPlanStore } from "./plan-store"
import { DocumentStore } from "./document-store"
import { GoalChildResult } from "./goal-child-result"

type Db = Database.Interface["db"]
type Reader = Db | Parameters<Parameters<Db["transaction"]>[0]>[0]
type Receipt = SessionRunCoordinator.OwnedReceipt<SessionSchema.ID>
export type Target = {
  readonly unitID: string
  readonly bindingHash: string
  readonly stage: GoalChildSchema.Stage
  readonly inputID: string
  readonly admittedSeq: number
}
type Prepared = { readonly target: Target; readonly sessionID: SessionSchema.ID }
type Proof = {
  readonly prepared: Prepared
  readonly executionID: string
  readonly instanceID: string
  readonly receipt: Receipt
  live: boolean
  phase: "starting" | "running"
  link?: GoalChildSchema.Execution
}
// Neither this Context reference nor its tokens are exported. Persisted execution JSON is evidence
// for diagnosis, never the authority to manufacture a running/cold witness.
const Current = Context.Reference<object | undefined>("GoalChild.private-execution", { defaultValue: () => undefined })
const witnesses = new WeakMap<object, Proof>()
const failure = (message: string) => new GoalChildSchema.Error({ code: "GOAL_CHILD_RECOVERY_REQUIRED", message })

export const target = (row: GoalChild.Row): Target => ({
  unitID: row.unit_id,
  bindingHash: row.binding_hash,
  stage: (row.binding.version !== 1 ? row.inputs.at(-1)! : row.inputs[0]).stage,
  inputID: (row.binding.version !== 1 ? row.inputs.at(-1)! : row.inputs[0]).inputID,
  admittedSeq: (row.binding.version !== 1 ? row.inputs.at(-1)! : row.inputs[0]).admittedSeq!,
})

export const prepareForJoin = (db: Db, target: Target) =>
  Effect.gen(function* () {
    const source = yield* GoalChild.executionSource(db, target.unitID)
    yield* match(source, target)
    return { sessionID: source.row.child_session_id }
  })

export const prepare = (db: Db, target: Target) =>
  Effect.gen(function* () {
    const source = yield* GoalChild.executionSource(db, target.unitID)
    yield* match(source, target)
    yield* virgin(db, source)
    return { target: Object.freeze({ ...target }), sessionID: SessionSchema.ID.make(source.row.child_session_id) }
  })

/** Same check at Store, runner, provider seal, tool admission/body, and after permission approval. */
export const requireExecution = (db: Reader, sessionID: string) =>
  Effect.gen(function* () {
    const current = yield* Current
    const proof = current ? witnesses.get(current) : undefined
    if (!proof) return yield* GoalChild.requireExecution(db, sessionID)
    if (!proof.live || proof.prepared.sessionID !== sessionID)
      return yield* failure("Goal owned execution witness is no longer current")
    const source = yield* GoalChild.executionSource(db, proof.prepared.target.unitID)
    yield* match(source, proof.prepared.target)
    if (proof.phase === "starting") {
      yield* virgin(db, source)
      return source
    }
    if (
      !proof.link ||
      source.session.execution_claim_token !== proof.link.claimToken ||
      GoalControl.fingerprint(source.input.execution) !== GoalControl.fingerprint(proof.link) ||
      source.input.execution?.state !== "bound"
    )
      return yield* failure("Goal owned claim and durable input link no longer agree")
    return source
  })

/** The canonical runner must not silently substitute an aliased agent for a frozen Goal binding. */
export const requireAgent = (db: Reader, sessionID: string, agentID: string) =>
  Effect.gen(function* () {
    const source = yield* requireExecution(db, sessionID)
    if (source && source.row.binding.agent !== agentID)
      return yield* new GoalChildSchema.Error({
        code: "GOAL_CHILD_CONFLICT",
        message: "Resolved agent differs from the frozen Goal child binding",
      })
  })

export const requireTool = (
  db: Reader,
  input: {
    sessionId: string
    receiptId: string
    providerAttemptId: string
    ownerToken: string
  },
) =>
  Effect.gen(function* () {
    const source = yield* requireExecution(db, input.sessionId)
    if (!source) return
    const receipt = yield* db.get<{ user_message_id: string; activity_id: string; state: string }>(sql`
    SELECT user_message_id,activity_id,state FROM session_v2_provider_turn_receipt
    WHERE receipt_id=${input.receiptId} AND session_id=${input.sessionId}
      AND provider_attempt_id=${input.providerAttemptId} AND owner_token=${input.ownerToken}`)
    if (
      !receipt ||
      !["streaming", "settled"].includes(receipt.state) ||
      receipt.user_message_id !== source.input.inputID ||
      receipt.activity_id !== source.input.activityID
    )
      return yield* failure("Tool admission is not associated with this owned Goal provider turn")
  })

/** Actual provider receipt and promoted input must belong to this exact stage, not a later drain. */
export const requireProvider = (db: Reader, input: { sessionID: string; activityID: string; inputID: string }) =>
  Effect.gen(function* () {
    const source = yield* requireExecution(db, input.sessionID)
    if (!source) return
    if (source.input.inputID !== input.inputID || source.inbox.promoted_seq === null)
      return yield* failure("Provider turn does not belong to the owned Goal input")
    const linked = yield* db.get<{ activity_id: string }>(sql`
      SELECT activity_id FROM session_activity_input WHERE input_id=${input.inputID}`)
    if (linked?.activity_id !== input.activityID)
      return yield* failure("Provider turn lacks the exact Goal input activity association")
    if (source.input.activityID !== null && source.input.activityID !== input.activityID)
      return yield* failure("Goal input was associated with a different activity")
    if (source.input.activityID === null)
      yield* db
        .update(GoalChildUnitTable)
        .set({
          inputs: source.row.inputs.map((item) =>
            item.inputID === input.inputID ? { ...item, activityID: input.activityID } : item,
          ),
          updated_at: Date.now(),
        })
        .where(eq(GoalChildUnitTable.unit_id, source.row.unit_id))
        .run()
  })

/** One issuer per real Local service. Receipt registration alone authorizes no execution. */
export const make = (db: Db) => {
  const instanceID = randomUUID()
  const entries = new WeakMap<Receipt, object>()
  const withReceipt = <A, E, R>(receipt: Receipt | undefined, effect: Effect.Effect<A, E, R>) => {
    const token = receipt ? entries.get(receipt) : undefined
    return effect.pipe(Effect.provideService(Current, token))
  }
  return {
    ordinary: (sessionID: string) => GoalChild.requireExecution(db, sessionID),
    prepare: (target: Target) => prepare(db, target),
    prepareForJoin: (target: Target) => prepareForJoin(db, target),
    transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      db.transaction(() => effect, { behavior: "immediate" }).pipe(GoalChildResult.withRuntimeIdentity(db), Effect.orDie),
    register: (receipt: Receipt, prepared: Prepared) => {
      const token = Object.freeze({})
      entries.set(receipt, token)
      witnesses.set(token, {
        prepared,
        executionID: randomUUID(),
        instanceID,
        receipt,
        live: true,
        phase: "starting",
      })
    },
    matches: (receipt: Receipt, target: Target) => {
      const token = entries.get(receipt)
      const proof = token ? witnesses.get(token) : undefined
      return !!proof?.live && GoalControl.fingerprint(proof.prepared.target) === GoalControl.fingerprint(target)
    },
    withReceipt,
    /** Called inside the actual Started checked commit, after the actual SessionStore claim CAS. */
    bind: (receipt: Receipt, claimToken: number, startedSeq: number) =>
      Effect.gen(function* () {
        const token = entries.get(receipt)
        const proof = token ? witnesses.get(token) : undefined
        if (!proof?.live || proof.phase !== "starting") return yield* failure("Goal starting witness is missing")
        const source = yield* GoalChild.executionSource(db, proof.prepared.target.unitID)
        yield* match(source, proof.prepared.target)
        if (source.session.execution_claim_token !== claimToken || source.input.execution)
          return yield* failure("Goal claim or input link changed during Started")
        const link: GoalChildSchema.Execution = {
          version: 1,
          executionID: proof.executionID,
          executionInstanceID: instanceID,
          goalOwnerID: GoalControl.ownerID,
          claimToken,
          startedSeq,
          controlRevision: source.permit.control_revision,
          state: "bound",
        }
        yield* db
          .update(GoalChildUnitTable)
          .set({
            inputs: source.row.inputs.map((item) =>
              item.inputID === source.input.inputID ? { ...item, execution: link } : item,
            ),
            updated_at: Date.now(),
          })
          .where(eq(GoalChildUnitTable.unit_id, source.row.unit_id))
          .run()
        return link
      }),
    committed: (receipt: Receipt, link: GoalChildSchema.Execution) => {
      const token = entries.get(receipt)
      const proof = token ? witnesses.get(token) : undefined
      if (!proof?.live || proof.executionID !== link.executionID) throw failure("Goal Started witness changed")
      proof.link = link
      proof.phase = "running"
    },
    /** Runs in terminal event/release transaction; drain success never creates a business result. */
    finish: (receipt: Receipt | undefined, state: GoalChildSchema.Execution["state"]) =>
      Effect.gen(function* () {
        const token = receipt ? entries.get(receipt) : undefined
        const proof = token ? witnesses.get(token) : undefined
        if (!proof?.link) return
        const row = yield* db
          .select()
          .from(GoalChildUnitTable)
          .where(eq(GoalChildUnitTable.unit_id, proof.prepared.target.unitID))
          .get()
        const input = row?.inputs.find((item) => item.inputID === proof.prepared.target.inputID)
        if (!row || !input || GoalControl.fingerprint(input.execution) !== GoalControl.fingerprint(proof.link))
          return yield* failure("Goal terminal link changed; claim remains fenced")
        yield* db
          .update(GoalChildUnitTable)
          .set({
            inputs: row.inputs.map((item) =>
              item.inputID === input.inputID ? { ...item, execution: { ...proof.link!, state } } : item,
            ),
            updated_at: Date.now(),
          })
          .where(eq(GoalChildUnitTable.unit_id, row.unit_id))
          .run()
      }),
    revoke: (receipt: Receipt | undefined) => {
      const token = receipt ? entries.get(receipt) : undefined
      const proof = token ? witnesses.get(token) : undefined
      if (proof) proof.live = false
      if (token) witnesses.delete(token)
      if (receipt) entries.delete(receipt)
    },
  }
}

function match(source: Effect.Success<ReturnType<typeof GoalChild.executionSource>>, target: Target) {
  return source.row.binding_hash === target.bindingHash &&
    source.input.stage === target.stage &&
    source.input.inputID === target.inputID &&
    source.input.admittedSeq === target.admittedSeq
    ? Effect.void
    : Effect.fail(failure("Goal execution selector differs from durable binding"))
}

function virgin(db: Reader, source: Effect.Success<ReturnType<typeof GoalChild.executionSource>>) {
  return Effect.gen(function* () {
    if (
      source.input.execution ||
      source.input.activityID !== null ||
      source.inbox.promoted_seq !== null ||
      source.session.execution_claim_token !== null
    )
      return yield* failure("Goal child already has execution evidence; explicit recovery is required")
    if (source.row.binding.version === 3) {
      const checkpoint = yield* GoalTickCheckpointV2.read(db, source.row.permit_id).pipe(
        Effect.mapError(() => failure("Goal scratch checkpoint is unavailable")),
      )
      const activation = checkpoint?.journal.activations.find((item) => item.unitID === source.row.unit_id)
      const scratch = activation ? checkpoint!.journal.program.roles[activation.role].scratch : undefined
      if (scratch) {
        const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(GoalTickProgram.DocumentPayload))(
          scratch.payload,
        )
        const receipt = source.row.inputs[0].scratch
        if (!receipt || Option.isNone(decoded) || receipt.payloadHash !== scratch.payloadHash || receipt.version !== 1)
          return yield* failure("Goal scratch preparation has no complete admission receipt")
        const current = yield* Effect.try({
          try: () =>
            DocumentStore.openExact(DeepAgentPlanStore.planStoreRoot(source.row.child_session_id), [
              scratch.documentID,
            ]).get(scratch.documentID),
          catch: () => failure("Goal scratch file is unavailable before execution"),
        })
        if (
          !current ||
          current.version !== receipt.version ||
          current.hash !== `sha256:${receipt.hash}` ||
          GoalTickProgram.canonical(Object.fromEntries(Object.entries(current).filter(([key]) => key !== "hash"))) !==
            scratch.payload
        )
          return yield* failure("Goal scratch file differs from its admitted complete bytes")
      }
    }
    if (source.row.binding.version !== 1 && source.row.inputs.length > 1) {
      for (const prior of source.row.inputs.slice(0, -1))
        yield* GoalChildResult.inspect(db, source.row.unit_id, prior.stage).pipe(
          Effect.mapError(() => failure("Goal predecessor result no longer has complete durable evidence")),
        )
      const counts = yield* db
        .get<{ activities: number; unbound: number }>(
          sql`
        SELECT (SELECT count(*) FROM session_activity WHERE session_id=${source.row.child_session_id}) AS activities,
        (SELECT count(*) FROM session_v2_provider_turn_receipt WHERE session_id=${source.row.child_session_id}
          AND user_message_id NOT IN (SELECT value->>'$.inputID' FROM json_each(${JSON.stringify(source.row.inputs.slice(0, -1))}))) AS unbound`,
        )
        .pipe(Effect.orDie)
      if (counts?.activities !== source.row.inputs.length - 1 || counts.unbound !== 0)
        return yield* failure("Goal successor has unaccounted activity or provider evidence")
      return
    }
    const evidence = yield* db
      .get<{ count: number }>(
        sql`SELECT
      (SELECT COUNT(*) FROM session_activity WHERE session_id=${source.row.child_session_id}) +
      (SELECT COUNT(*) FROM session_v2_provider_turn_receipt WHERE session_id=${source.row.child_session_id}) +
      (SELECT COUNT(*) FROM session_v2_tool_effect_admission WHERE session_id=${source.row.child_session_id}) AS count`,
      )
      .pipe(Effect.orDie)
    if (evidence?.count !== 0) return yield* failure("Goal child has prior activity/provider/tool evidence")
  })
}
