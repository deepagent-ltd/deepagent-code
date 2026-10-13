export * as GoalChildResult from "./goal-child-result"

import { and, asc, eq, getTableColumns, inArray, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { LLMEvent, Usage, ToolOutput } from "@deepagent-code/llm/schema"
import {
  SessionActivityInputTable,
  SessionActivityTable,
  SessionProviderAttemptTable,
} from "../context-federation/session-sql"
import { SessionInputTable, SessionMessageTable } from "../session/sql"
import { SessionSchema } from "../session/schema"
import { SessionMessage } from "../session/message"
import { V2ProviderTurnReceiptTable } from "../session/runner/v2-provider-turn.sql"
import { V2ToolEffectAdmissionTable, V2ToolEffectTable } from "../session/runner/v2-tool-effect.sql"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { GoalChild } from "./goal-child"
import { DeepAgentPlanStore } from "./plan-store"
import { GoalTickProgram } from "./goal-tick-program"
import { GoalChildSchema } from "./goal-child.schema"
import { GoalChildPolicy } from "./goal-child-policy"
import { GoalControl } from "./goal-control"
import { GoalTickCheckpoint } from "./goal-tick-checkpoint"
import { GoalTickCheckpointV2 } from "./goal-tick-checkpoint-v2"
import { GoalTickCheckpointSchema } from "./goal-tick-checkpoint.schema"

const identity: unique symbol = Symbol("GoalChildResult.Proof")
export type Proof = { readonly [identity]: true }
type Facts = {
  result: GoalTickCheckpointSchema.Result
  bindingHash: string
  text: string
  value: unknown
  inspectionBytes: number
  proposal?: {
    receipt: GoalChildSchema.PlanProposal
    plan: NonNullable<ReturnType<typeof DeepAgentPlanStore.decodePlanDoc>>
  }
}
const proofs = new WeakMap<object, Facts>()
// This projection is part of the persisted Goal proof. New private leaf
// evidence must not change historical hashes or inspection byte budgets.
const goalEffectColumns = {
  effect_id: V2ToolEffectTable.effect_id,
  session_id: V2ToolEffectTable.session_id,
  provider_attempt_id: V2ToolEffectTable.provider_attempt_id,
  receipt_id: V2ToolEffectTable.receipt_id,
  tool_call_id: V2ToolEffectTable.tool_call_id,
  tool_name: V2ToolEffectTable.tool_name,
  effect_kind: V2ToolEffectTable.effect_kind,
  state: V2ToolEffectTable.state,
  outcome_hash: V2ToolEffectTable.outcome_hash,
  error_code: V2ToolEffectTable.error_code,
  grant_receipt_id: V2ToolEffectTable.grant_receipt_id,
  grant_owner_id: V2ToolEffectTable.grant_owner_id,
  grant_state: V2ToolEffectTable.grant_state,
  grant_version: V2ToolEffectTable.grant_version,
  owner_token: V2ToolEffectTable.owner_token,
  time_created: V2ToolEffectTable.time_created,
      }
const fail = (message: string) => new GoalChildSchema.Error({ code: "GOAL_CHILD_RECOVERY_REQUIRED", message })

/** Reads the real activity/attempt/effect authorities. No caller-provided success or digest is accepted. */
export const inspect = (db: GoalTickCheckpoint.Reader, unitID: string, stage: GoalChildSchema.Stage) =>
  db
    .transaction((tx) => inspectInTransaction(tx, unitID, stage), { behavior: "deferred" })
    .pipe(
      Effect.catchTag("SqlError", () => fail("Goal result ledger snapshot could not be read")),
      Effect.catchDefect(() => fail("Goal result ledger snapshot could not be decoded")),
    )

const inspectInTransaction = (db: GoalTickCheckpoint.Reader, unitID: string, stage: GoalChildSchema.Stage) =>
  Effect.gen(function* () {
    const unit = yield* GoalChild.read(db, unitID)
    const input = unit?.inputs.find((item) => item.stage === stage)
    if (
      !unit ||
      unit.binding.version === 1 ||
      !input?.execution ||
      input.execution.state !== "settled" ||
      input.admittedSeq === null ||
      input.activityID === null
    )
      return yield* fail("Goal stage lacks a settled owned execution link")
    const sessionID = SessionSchema.ID.make(unit.child_session_id)
    const inbox = yield* db
      .select()
      .from(SessionInputTable)
      .where(eq(SessionInputTable.id, SessionMessage.ID.make(input.inputID)))
      .get()
      .pipe(Effect.orDie)
    const activity = yield* db
      .select()
      .from(SessionActivityTable)
      .where(eq(SessionActivityTable.activity_id, input.activityID))
      .get()
      .pipe(Effect.orDie)
    const members = yield* db
      .select()
      .from(SessionActivityInputTable)
      .where(eq(SessionActivityInputTable.activity_id, input.activityID))
      .limit(2)
      .all()
      .pipe(Effect.orDie)
    if (
      !inbox ||
      inbox.session_id !== sessionID ||
      inbox.admitted_seq !== input.admittedSeq ||
      inbox.delivery !== input.delivery ||
      inbox.revert_epoch !== null ||
      inbox.promoted_seq === null ||
      GoalControl.fingerprint(inbox.prompt) !== input.promptHash ||
      activity?.session_id !== sessionID ||
      activity.state !== "settled" ||
      activity.trigger_input_id !== input.inputID ||
      !activity.final_message_id ||
      members.length !== 1 ||
      members[0].input_id !== input.inputID ||
      members[0].admitted_seq !== input.admittedSeq
    )
      return yield* fail("Goal result does not belong to its exact promoted input and settled activity")
    const messageBytes = yield* db
      .get<{
        bytes: number
      }>(
        sql`SELECT length(CAST(data AS BLOB)) AS bytes FROM session_message WHERE id=${activity.final_message_id} AND session_id=${sessionID}`,
      )
      .pipe(Effect.orDie)
    if (!messageBytes || !Number.isSafeInteger(messageBytes.bytes) || messageBytes.bytes > 1_048_576)
      return yield* fail("Goal assistant projection exceeds the bounded inspection bytes")
    const message = yield* db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.id, SessionMessage.ID.make(activity.final_message_id)))
      .get()
      .pipe(Effect.orDie)
    if (
      !message ||
      message.session_id !== sessionID ||
      message.type !== "assistant" ||
      message.seq <= inbox.promoted_seq ||
      !("finish" in message.data) ||
      message.data.finish !== "stop" ||
      ("error" in message.data && message.data.error)
    )
      return yield* fail("Goal activity has no successful final assistant message")
    const orphan = yield* db
      .get<{ found: number }>(
        sql`SELECT 1 AS found FROM (
    SELECT a.session_id,a.receipt_id FROM session_v2_tool_effect_admission a WHERE a.session_id=${sessionID}
    UNION ALL SELECT e.session_id,e.receipt_id FROM session_v2_tool_effect e WHERE e.session_id=${sessionID}
  ) t LEFT JOIN session_v2_provider_turn_receipt r ON r.receipt_id=t.receipt_id
  WHERE r.receipt_id IS NULL OR r.session_id<>t.session_id LIMIT 1`,
      )
      .pipe(Effect.orDie)
    if (orphan) return yield* fail("Goal child has a tool obligation without a matching provider receipt")
    const receiptsForActivity = db
      .select({ id: V2ProviderTurnReceiptTable.receipt_id })
      .from(V2ProviderTurnReceiptTable)
      .where(
        and(
          eq(V2ProviderTurnReceiptTable.session_id, sessionID),
          eq(V2ProviderTurnReceiptTable.activity_id, activity.activity_id),
        ),
      )
    const providerWhere = and(
      eq(V2ProviderTurnReceiptTable.session_id, sessionID),
      eq(V2ProviderTurnReceiptTable.activity_id, activity.activity_id),
    )
    const attemptWhere = and(
      eq(SessionProviderAttemptTable.session_id, sessionID),
      eq(SessionProviderAttemptTable.activity_id, activity.activity_id),
    )
    const admissionWhere = and(
      eq(V2ToolEffectAdmissionTable.session_id, sessionID),
      inArray(V2ToolEffectAdmissionTable.receipt_id, receiptsForActivity),
    )
    const effectWhere = and(
      eq(V2ToolEffectTable.session_id, sessionID),
      inArray(V2ToolEffectTable.receipt_id, receiptsForActivity),
    )
    // This is an audit-read limit, not a new execution quota. No prefix can certify a success.
    // Probe bounded constant rows first, then measure complete encoded ledgers inside SQLite before
    // loading any provider artifacts. Oversize or unknown work retains its existing reservation.
    const probes = [
      db
        .select({ one: sql<number>`1` })
        .from(V2ProviderTurnReceiptTable)
        .where(providerWhere)
        .limit(513)
        .all(),
      db
        .select({ one: sql<number>`1` })
        .from(SessionProviderAttemptTable)
        .where(attemptWhere)
        .limit(513)
        .all(),
      db
        .select({ one: sql<number>`1` })
        .from(V2ToolEffectAdmissionTable)
        .where(admissionWhere)
        .limit(4097)
        .all(),
      db
        .select({ one: sql<number>`1` })
        .from(V2ToolEffectTable)
        .where(effectWhere)
        .limit(4097)
        .all(),
    ]
    for (const [index, probe] of probes.entries())
      if ((yield* probe.pipe(Effect.orDie)).length > (index < 2 ? 512 : 4096))
        return yield* fail("Goal ledger exceeds the bounded inspection count")
    const sizes = [
      db
        .select({
          bytes: sql<number>`coalesce(sum(length(CAST(json_array(${sql.join(
            Object.values(getTableColumns(V2ProviderTurnReceiptTable)).map((column) => sql`${column}`),
            sql`,`,
          )}) AS BLOB))),0)`,
        })
        .from(V2ProviderTurnReceiptTable)
        .where(providerWhere)
        .get(),
      db
        .select({
          bytes: sql<number>`coalesce(sum(length(CAST(json_array(${sql.join(
            Object.values(getTableColumns(SessionProviderAttemptTable)).map((column) => sql`${column}`),
            sql`,`,
          )}) AS BLOB))),0)`,
        })
        .from(SessionProviderAttemptTable)
        .where(attemptWhere)
        .get(),
      db
        .select({
          bytes: sql<number>`coalesce(sum(length(CAST(json_array(${sql.join(
            Object.values(getTableColumns(V2ToolEffectAdmissionTable)).map((column) => sql`${column}`),
            sql`,`,
          )}) AS BLOB))),0)`,
        })
        .from(V2ToolEffectAdmissionTable)
        .where(admissionWhere)
        .get(),
      db
        .select({
          bytes: sql<number>`coalesce(sum(length(CAST(json_array(${sql.join(
            Object.values(goalEffectColumns).map((column) => sql`${column}`),
            sql`,`,
          )}) AS BLOB))),0)`,
        })
        .from(V2ToolEffectTable)
        .where(effectWhere)
        .get(),
    ]
    let inspectedBytes = 0
    for (const measure of sizes) {
      const size = (yield* measure.pipe(Effect.orDie))?.bytes
      if (size === undefined || !Number.isSafeInteger(size) || size < 0 || (inspectedBytes += size) > 67_108_864)
        return yield* fail("Goal ledger exceeds the bounded inspection bytes")
    }
    const providers = yield* db
      .select()
      .from(V2ProviderTurnReceiptTable)
      .where(
        and(
          eq(V2ProviderTurnReceiptTable.session_id, sessionID),
          eq(V2ProviderTurnReceiptTable.activity_id, activity.activity_id),
        ),
      )
      .orderBy(asc(V2ProviderTurnReceiptTable.provider_turn_seq))
      .all()
      .pipe(Effect.orDie)
    if (!providers.length) return yield* fail("Goal result has no provider ledger")
    const attempts = yield* db.select().from(SessionProviderAttemptTable).where(attemptWhere).all().pipe(Effect.orDie)
    if (attempts.length !== providers.length) return yield* fail("Goal activity has an unmatched provider attempt")
    const attemptsByID = new Map(attempts.map((attempt) => [attempt.attempt_id, attempt]))
    const usage = {
      input: 0,
      nonCachedInput: 0,
      output: 0,
      reasoning: 0 as number | null,
      visibleOutput: 0 as number | null,
      cacheRead: 0,
      cacheWrite: 0,
    }
    const derived = new Set<"nonCachedInput" | "cacheRead" | "cacheWrite">()
    for (const receipt of providers) {
      if (
        receipt.user_message_id !== input.inputID ||
        receipt.state !== "settled" ||
        !receipt.provider_attempt_id ||
        !receipt.outcome_artifact ||
        receipt.outcome_hash !== Hash.sha256(CanonicalJson.stringify(receipt.outcome_artifact))
      )
        return yield* fail("Goal provider receipt is unresolved or its artifact changed")
      const attempt = attemptsByID.get(receipt.provider_attempt_id)
      if (
        !attempt ||
        attempt.session_id !== sessionID ||
        attempt.activity_id !== activity.activity_id ||
        attempt.provider_turn_seq !== receipt.provider_turn_seq ||
        attempt.owner_token !== receipt.owner_token ||
        attempt.execution_claim_token !== input.execution.claimToken ||
        attempt.state !== "settled" ||
        attempt.provider_id !== receipt.provider_id
      )
        return yield* fail("Goal provider attempt is not owned by this stage")
      const events = Schema.decodeUnknownOption(Schema.Array(LLMEvent))(receipt.outcome_artifact)
      if (Option.isNone(events)) return yield* fail("Goal provider artifact is malformed")
      const finishes = events.value.filter(LLMEvent.is.stepFinish)
      if (finishes.length !== 1 || !finishes[0].usage || events.value.some(LLMEvent.is.providerError))
        return yield* fail("Goal provider usage is missing or ambiguous")
      const value = normalizeUsage(finishes[0].usage)
      if (!value) return yield* fail("Goal provider usage is not a complete non-overlapping accounting")
      if (value.inferredInputCategory) derived.add(value.inferredInputCategory)
      usage.input += value.usage.input
      usage.nonCachedInput += value.usage.nonCachedInput
      usage.output += value.usage.output
      usage.reasoning =
        usage.reasoning === null || value.usage.reasoning === null ? null : usage.reasoning + value.usage.reasoning
      usage.visibleOutput = usage.reasoning === null ? null : usage.output - usage.reasoning
      usage.cacheRead += value.usage.cacheRead
      usage.cacheWrite += value.usage.cacheWrite
    }
    const admissions = yield* db
      .select()
      .from(V2ToolEffectAdmissionTable)
      .where(admissionWhere)
      .orderBy(asc(V2ToolEffectAdmissionTable.admission_id))
      .all()
      .pipe(Effect.orDie)
    const effects = yield* db
      .select(goalEffectColumns)
      .from(V2ToolEffectTable)
      .where(effectWhere)
      .orderBy(asc(V2ToolEffectTable.effect_id))
      .all()
      .pipe(Effect.orDie)
    const effectsByCall = new Map(
      effects.map((effect) => [GoalControl.fingerprint([effect.receipt_id, effect.tool_call_id]), effect]),
    )
    const providersByID = new Map(providers.map((receipt) => [receipt.receipt_id, receipt]))
    if (admissions.length !== effects.length) return yield* fail("Goal stage has a pending or orphan tool effect")
    for (const admission of admissions) {
      const effect = effectsByCall.get(GoalControl.fingerprint([admission.receipt_id, admission.tool_call_id]))
      const receipt = providersByID.get(admission.receipt_id)!
      if (
        !effect ||
        effect.provider_attempt_id !== admission.provider_attempt_id ||
        effect.provider_attempt_id !== receipt.provider_attempt_id ||
        effect.owner_token !== admission.owner_token ||
        effect.owner_token !== receipt.owner_token ||
        effect.tool_name !== admission.tool_name ||
        effect.effect_kind !== admission.effect_kind ||
        !["settled", "failed"].includes(effect.state) ||
        effect.grant_state === "unknown" ||
        effect.grant_state === "started" ||
        !/^[a-f0-9]{64}$/.test(effect.outcome_hash)
      )
        return yield* fail("Goal tool effect is not a matching known settlement")
    }
    const assistant = Schema.decodeUnknownOption(SessionMessage.Assistant)({
      ...message.data,
      id: message.id,
      type: message.type,
    })
    if (Option.isNone(assistant)) return yield* fail("Goal assistant projection is malformed")
    const text = assistant.value.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
    const checkpoint =
      unit.binding.version === 3
        ? yield* GoalTickCheckpointV2.read(db, unit.permit_id)
        : yield* GoalTickCheckpoint.read(db, unit.permit_id)
    const proposal = !input.proposal ? undefined : yield* Effect.gen(function* () {
      if (unit.binding.version !== 3 || stage !== "plain" || !input.scratch)
        return yield* fail("Goal Plan proposal lacks a frozen scratch source")
      const receipt = input.proposal!
      const effect = effects.find((item) => item.tool_call_id === receipt.toolCallID && item.tool_name === "plan")
      if (!effect || effect.state !== "settled") return yield* fail("Goal Plan proposal has no settled native tool call")
      const bytes = yield* db.get<{ bytes: number }>(sql`SELECT length(CAST(data AS BLOB)) AS bytes
        FROM session_message WHERE id=${receipt.messageID} AND session_id=${sessionID}`).pipe(Effect.orDie)
      if (!bytes || bytes.bytes > 1_048_576 || (inspectedBytes += bytes.bytes) > 67_108_864)
        return yield* fail("Goal Plan result exceeds the bounded inspection bytes")
      const projected = yield* db.select().from(SessionMessageTable).where(and(
        eq(SessionMessageTable.id, SessionMessage.ID.make(receipt.messageID)),
        eq(SessionMessageTable.session_id, sessionID),
      )).get().pipe(Effect.orDie)
      const assistant = projected && Schema.decodeUnknownOption(SessionMessage.Assistant)({
        ...projected.data, id: projected.id, type: projected.type,
      })
      if (!assistant || Option.isNone(assistant)) return yield* fail("Goal Plan tool projection is unavailable")
      const calls = assistant.value.content.filter((part) => part.type === "tool" && part.id === receipt.toolCallID)
      const call = calls[0]
      const output = call?.type === "tool" && call.state.status === "completed"
        ? Schema.decodeUnknownOption(ToolOutput)({ structured: call.state.structured, content: call.state.content }) : Option.none()
      const result = Option.isSome(output) ? ToolOutput.toResultValue(output.value) : undefined
      if (calls.length !== 1 || call.type !== "tool" || call.name !== "plan" || call.state.status !== "completed" ||
        !result || result.type !== "json" ||
        Hash.sha256(CanonicalJson.stringify(result)) !== effect.outcome_hash)
        return yield* fail("Goal Plan proposal differs from its tool settlement")
      const decodedProposal = Schema.decodeUnknownOption(Schema.Struct({
        owned_proposal: GoalChildSchema.PlanProposal,
        plan_protocol: Schema.Literals(["success", "no_progress"]),
      }))(result.value)
      if (Option.isNone(decodedProposal) || GoalControl.fingerprint(decodedProposal.value.owned_proposal) !== GoalControl.fingerprint(receipt))
        return yield* fail("Goal Plan proposal was not returned by its native leaf")
      const role = checkpoint && (checkpoint.journal.version === 2 || checkpoint.journal.version === 3)
        ? checkpoint.journal.program.roles.find((item) => item.key === unit.role_key) : undefined
      if (!role?.scratch || receipt.documentID !== role.scratch.documentID)
        return yield* fail("Goal Plan proposal changed its exact document target")
      const actual = yield* Effect.try({
        try: () => DeepAgentPlanStore.readExactPlan(sessionID, receipt.documentID),
        catch: () => fail("Goal Plan proposal document is unavailable"),
      })
      if (!actual.doc || !actual.plan || actual.doc.version !== receipt.documentVersion ||
        actual.doc.hash !== `sha256:${receipt.documentHash}`)
        return yield* fail("Goal Plan proposal document changed after its tool receipt")
      const frozen = Schema.decodeUnknownSync(Schema.fromJsonString(GoalTickProgram.DocumentPayload))(role.scratch.payload)
      const source = DeepAgentPlanStore.decodePlanDoc(frozen.body)
      const shape = (plan: NonNullable<typeof source>) => ({
        goal: plan.goal, assumptions: plan.assumptions,
        steps: plan.steps.map((step) => ({ id: step.step_id, title: step.title, acceptance: step.acceptance ?? null })),
      })
      if (!source || GoalControl.fingerprint(shape(source)) !== GoalControl.fingerprint(shape(actual.plan)))
        return yield* fail("Goal Plan proposal changed frozen acceptance")
      return { receipt, plan: actual.plan }
    })
    const recorded = checkpoint?.journal.results.find((result) => result.unitID === unitID && result.stage === stage)
    const decoded =
      GoalChildPolicy.decodeResult(unit.binding, stage, text) ??
      (recorded && recorded.resultHash === GoalControl.fingerprint({ text })
        ? { outcome: recorded.outcome, schemaHash: recorded.schemaHash, value: null }
        : undefined)
    if (!decoded) return yield* fail("Goal result decoder or bounded content is unavailable")
    const result: GoalTickCheckpointSchema.Result = {
      version: 1,
      unitID,
      stage,
      inputID: input.inputID,
      admittedSeq: input.admittedSeq,
      activityID: activity.activity_id,
      messageID: message.id,
      executionID: input.execution.executionID,
      claimToken: input.execution.claimToken,
      providers: {
        count: providers.length,
        through: providers.at(-1)!.provider_turn_seq,
        hash: GoalControl.fingerprint(providers),
      },
      tools: {
        count: effects.length,
        through: effects.reduce((max, effect) => Math.max(max, effect.time_created), 0),
        hash: GoalControl.fingerprint({ admissions, effects, ...(proposal ? { proposal: proposal.receipt } : {}) }),
      },
      outcome: decoded.outcome,
      resultHash: GoalControl.fingerprint({ text }),
      schemaHash: decoded.schemaHash,
      usage,
      usageDerivation: { version: 1, inferredInputCategories: [...derived].sort() },
    }
    if (recorded && GoalControl.fingerprint(recorded) !== GoalControl.fingerprint(result))
      return yield* fail("Recorded Goal result differs from its actual ledgers")
    if (
      !Schema.is(GoalTickCheckpointSchema.Result)(result) ||
      Buffer.byteLength(GoalTickCheckpoint.canonical(result)) > GoalTickCheckpointSchema.RESULT_BYTES
    )
      return yield* fail("Goal result exceeds the reserved proof contract")
    const token: Proof = Object.freeze({ [identity]: true as const })
    proofs.set(token, {
      result,
      bindingHash: unit.binding_hash,
      text,
      value: decoded.value,
      inspectionBytes: inspectedBytes,
      ...(proposal ? { proposal } : {}),
    })
    return token
  })

export const recheck = (db: GoalTickCheckpoint.Reader, proof: Proof) =>
  Effect.gen(function* () {
    const facts = proofs.get(proof)
    if (!facts) return yield* fail("Goal result proof is not native")
    const fresh = yield* inspect(db, facts.result.unitID, facts.result.stage)
    const checked = proofs.get(fresh)!
    if (
      checked.bindingHash !== facts.bindingHash ||
      GoalControl.fingerprint(checked.result) !== GoalControl.fingerprint(facts.result)
    )
      return yield* fail("Goal result ledger changed before checkpoint commit")
    return checked
  })

/** Pure accounting of the native LLM.Usage contract, never a result-authority constructor. */
export function normalizeUsage(value: Usage) {
  const inputs = [value.nonCachedInputTokens, value.cacheReadInputTokens, value.cacheWriteInputTokens]
  const missing = inputs.filter((item) => item === undefined).length
  const remaining =
    value.inputTokens === undefined
      ? undefined
      : value.inputTokens - inputs.reduce<number>((sum, item) => sum + (item ?? 0), 0)
  const known = inputs.map((item) => item ?? (missing === 1 ? remaining : undefined))
  const fields = [
    ...known,
    value.inputTokens,
    value.outputTokens,
    ...(value.reasoningTokens === undefined ? [] : [value.reasoningTokens]),
    ...(value.totalTokens === undefined ? [] : [value.totalTokens]),
  ]
  if (
    fields.some((item) => !Number.isSafeInteger(item) || item! < 0) ||
    (value.reasoningTokens !== undefined && value.reasoningTokens > value.outputTokens!) ||
    value.inputTokens !== known.reduce<number>((sum, item) => sum + item!, 0) ||
    (value.totalTokens !== undefined && value.totalTokens !== value.inputTokens! + value.outputTokens!)
  )
    return undefined
  return {
    usage: {
      input: value.inputTokens!,
      nonCachedInput: known[0]!,
      output: value.outputTokens!,
      reasoning: value.reasoningTokens ?? null,
      visibleOutput: value.reasoningTokens === undefined ? null : value.outputTokens! - value.reasoningTokens,
      cacheRead: known[1]!,
      cacheWrite: known[2]!,
    },
    inferredInputCategory:
      missing === 1
        ? (["nonCachedInput", "cacheRead", "cacheWrite"] as const)[inputs.findIndex((item) => item === undefined)]
        : undefined,
  }
}

/** Rechecks the complete fixed result set with a cumulative audit budget, never a prefix. */
export const inspectMany = (
  db: GoalTickCheckpoint.Reader,
  results: readonly Pick<GoalTickCheckpointSchema.Result, "unitID" | "stage">[],
) =>
  Effect.gen(function* () {
    let bytes = 0
    for (const result of results) {
      const proof = yield* inspect(db, result.unitID, result.stage)
      bytes += proofs.get(proof)!.inspectionBytes
      if (bytes > 67_108_864) return yield* fail("Goal checkpoint ledgers exceed the cumulative inspection bytes")
    }
  })
