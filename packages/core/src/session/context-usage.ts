export * as SessionContextUsage from "./context-usage"

import { LLM, Message, SystemPart } from "@deepagent-code/llm"
import { and, desc, eq, max, sql } from "drizzle-orm"
import { DateTime, Effect, Option, Schema } from "effect"
import { AgentGateway } from "../agent-gateway"
import { AgentV2 } from "../agent"
import type { Database } from "../database/database"
import { SessionActivityTable, SessionContextSelectionTable } from "../context-federation/session-sql"
import { ModelV2 } from "../model"
import { ProviderV2 } from "../provider"
import { resolveModelProtocol } from "../model-protocol"
import type { SystemContextRegistry } from "../system-context/registry"
import type { SkillGuidance } from "../skill/guidance"
import type { ToolRegistry } from "../tool/registry"
import type { Git } from "../git"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { SessionContextEpoch } from "./context-epoch"
import { SessionHistory } from "./history"
import { SessionInfo } from "./info"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionContextUsageSchema } from "./context-usage.schema"
import { SessionContextEpochTable, SessionInputTable, SessionMessageTable, SessionTable } from "./sql"
import { PlanningPermissions } from "./planning-permissions"
import { SessionRunnerModel } from "./runner/model"
import { PreparedProviderTurn } from "./runner/prepared-provider-turn"
import { SessionHistoryProjection } from "./runner/session-history-projection"
import { toLLMMessages } from "./runner/to-llm-message"
import { buildDeepAgentPrompt, buildGovernedPlanContext } from "./runner/deepagent-prompt"
import { loadPromptContext } from "./runner/prompt-context"
import { V2ProviderTurnReceiptTable } from "./runner/v2-provider-turn.sql"

// SQLite extracts only the last canonical usage event; streaming text/opaque provider state never crosses this DTO.
const recordedUsage = sql<string | null>`(SELECT json_extract(value, '$.usage') FROM json_each(
  CASE WHEN json_valid(${V2ProviderTurnReceiptTable.outcome_artifact}) THEN ${V2ProviderTurnReceiptTable.outcome_artifact} ELSE '[]' END)
  WHERE json_extract(value, '$.type') = 'step-finish'
    AND json_type(value, '$.usage.inputTokens') IN ('integer', 'real')
    AND json_type(value, '$.usage.outputTokens') IN ('integer', 'real')
  ORDER BY CAST(key AS INTEGER) DESC LIMIT 1)`

const usageFields = {
  calls: sql<number>`count(*)`,
  reported: sql<number>`sum(CASE WHEN ${sql.identifier("usage")} IS NOT NULL THEN 1 ELSE 0 END)`,
  reasoningReported: sql<number>`sum(CASE WHEN json_type(${sql.identifier("usage")}, '$.reasoningTokens') IN ('integer','real') THEN 1 ELSE 0 END)`,
  cacheReadReported: sql<number>`sum(CASE WHEN json_type(${sql.identifier("usage")}, '$.cacheReadInputTokens') IN ('integer','real') THEN 1 ELSE 0 END)`,
  cacheWriteReported: sql<number>`sum(CASE WHEN json_type(${sql.identifier("usage")}, '$.cacheWriteInputTokens') IN ('integer','real') THEN 1 ELSE 0 END)`,
  nonCachedInput: sql<number>`sum(coalesce(json_extract(${sql.identifier("usage")}, '$.nonCachedInputTokens'),
    max(0, coalesce(json_extract(${sql.identifier("usage")}, '$.inputTokens'), 0) - coalesce(json_extract(${sql.identifier("usage")}, '$.cacheReadInputTokens'), 0) - coalesce(json_extract(${sql.identifier("usage")}, '$.cacheWriteInputTokens'), 0))))`,
  cacheRead: sql<number>`sum(coalesce(json_extract(${sql.identifier("usage")}, '$.cacheReadInputTokens'), 0))`,
  cacheWrite: sql<number>`sum(coalesce(json_extract(${sql.identifier("usage")}, '$.cacheWriteInputTokens'), 0))`,
  output: sql<number>`sum(coalesce(json_extract(${sql.identifier("usage")}, '$.visibleOutputTokens'),
    max(0, coalesce(json_extract(${sql.identifier("usage")}, '$.outputTokens'), 0) - coalesce(json_extract(${sql.identifier("usage")}, '$.reasoningTokens'), 0))))`,
  reasoning: sql<number>`sum(coalesce(json_extract(${sql.identifier("usage")}, '$.reasoningTokens'), 0))`,
}
const tokens = (
  value:
    | {
        nonCachedInput: number | null
        cacheRead: number | null
        cacheWrite: number | null
        output: number | null
        reasoning: number | null
      }
    | undefined,
): SessionContextUsageSchema.Tokens => ({
  nonCachedInput: value?.nonCachedInput ?? 0,
  cacheRead: value?.cacheRead ?? 0,
  cacheWrite: value?.cacheWrite ?? 0,
  output: value?.output ?? 0,
  reasoning: value?.reasoning ?? 0,
})

export type Services = {
  models: SessionRunnerModel.Interface
  agents: AgentV2.Interface
  tools: ToolRegistry.Interface
  systemContext: SystemContextRegistry.Interface
  skillGuidance: SkillGuidance.Interface
  gateway: AgentGateway.RuntimeInterface
  git?: Git.Interface
}

/** Observes only original ledgers and pure renderers. No admission, wake, epoch commit or provider/tool call. */
export const read = Effect.fn("SessionContextUsage.read")(function* (
  db: Database.Interface["db"],
  input: typeof SessionContextUsageSchema.Query.Type & {
    sessionID: string
    projectID: string
    directory: string
    workspaceID?: string
  },
  services?: Services,
) {
  const sessionID = SessionSchema.ID.make(input.sessionID)
  const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
  if (!row) return yield* new SessionContextUsageSchema.Unavailable({ reason: "not_found" })
  if (
    row.project_id !== input.projectID ||
    row.directory !== input.directory ||
    (row.workspace_id ?? undefined) !== input.workspaceID
  )
    return yield* new SessionContextUsageSchema.Unavailable({ reason: "scope_changed" })
  const head = yield* db
    .select({ seq: max(SessionMessageTable.seq) })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  const epoch = yield* db
    .select()
    .from(SessionContextEpochTable)
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  const activity =
    (yield* db
      .select()
      .from(SessionActivityTable)
      .where(and(eq(SessionActivityTable.session_id, sessionID), eq(SessionActivityTable.state, "active")))
      .orderBy(desc(SessionActivityTable.ordinal))
      .limit(1)
      .get()
      .pipe(Effect.orDie)) ??
    (yield* db
      .select()
      .from(SessionActivityTable)
      .where(eq(SessionActivityTable.session_id, sessionID))
      .orderBy(desc(SessionActivityTable.ordinal))
      .limit(1)
      .get()
      .pipe(Effect.orDie))
  const dispatched = and(
    eq(V2ProviderTurnReceiptTable.session_id, sessionID),
    eq(V2ProviderTurnReceiptTable.owner_mode, "v2"),
    sql`(${V2ProviderTurnReceiptTable.dispatching_at} IS NOT NULL OR ${V2ProviderTurnReceiptTable.first_event_at} IS NOT NULL OR ${V2ProviderTurnReceiptTable.state} = 'settled')`,
  )
  const aggregates = yield* db
    .all<{ [K in keyof typeof usageFields]: number | null } & { kind: "session" | "activity" }>(
      sql`
    WITH observed AS MATERIALIZED (
      SELECT ${V2ProviderTurnReceiptTable.activity_id} AS activity, ${recordedUsage} AS usage
      FROM ${V2ProviderTurnReceiptTable} WHERE ${dispatched}
    )
    SELECT 'session' AS kind, ${sql.join(
      Object.entries(usageFields).map(([key, value]) => sql`${value} AS ${sql.identifier(key)}`),
      sql`, `,
    )} FROM observed
    UNION ALL
    SELECT 'activity' AS kind, ${sql.join(
      Object.entries(usageFields).map(([key, value]) => sql`${value} AS ${sql.identifier(key)}`),
      sql`, `,
    )} FROM observed WHERE activity = ${activity?.activity_id ?? null}
  `,
    )
    .pipe(Effect.orDie)
  const totalUsage = aggregates.find((item) => item.kind === "session")
  const activityUsage = aggregates.find((item) => item.kind === "activity")
  const legacyTotals = {
    nonCachedInput: row.tokens_input,
    cacheRead: row.tokens_cache_read,
    cacheWrite: row.tokens_cache_write,
    output: row.tokens_output,
    reasoning: row.tokens_reasoning,
  }
  const recordedTotals = tokens(totalUsage)
  // Imported/legacy usage cannot be safely added to overlapping receipts. Keep the receipt ledger and disclose the gap.
  const legacyCoverage = Object.entries(legacyTotals).some(
    ([key, value]) => value > recordedTotals[key as keyof typeof recordedTotals],
  )
  const activeRequest = yield* db
    .select({ state: V2ProviderTurnReceiptTable.state })
    .from(V2ProviderTurnReceiptTable)
    .where(
      and(
        eq(V2ProviderTurnReceiptTable.session_id, sessionID),
        eq(V2ProviderTurnReceiptTable.owner_mode, "v2"),
        sql`${V2ProviderTurnReceiptTable.state} IN ('preparing','dispatching','streaming','indeterminate_after_crash')`,
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  const missing: string[] = activeRequest ? ["request_in_progress"] : []
  const result: SessionContextUsageSchema.Summary = {
    sessionID,
    observedAt: Date.now(),
    revision: Hash.sha256(
      CanonicalJson.stringify({
        updated: row.time_updated,
        historySeq: head?.seq ?? 0,
        epoch: epoch?.revision ?? null,
        model: [input.providerID, input.modelID, input.variant],
        draftRevision: input.draftRevision,
      }),
    ),
    estimate: {
      status: "unavailable",
      inputTokens: null,
      contextLimit: null,
      inputLimit: null,
      physicalInputBudget: null,
      reservedOutput: null,
      modelID: input.modelID ?? row.model?.id ?? null,
      providerID: input.providerID ?? row.model?.providerID ?? null,
      draftRevision: input.draftRevision,
      missing,
    },
    activity: activity
      ? {
          id: activity.activity_id,
          state: activity.state,
          current: activity.state === "active",
          calls: activityUsage?.calls ?? 0,
          reportedCalls: activityUsage?.reported ?? 0,
          unknownCalls: (activityUsage?.calls ?? 0) - (activityUsage?.reported ?? 0),
          reasoningReported:
            (activityUsage?.reported ?? 0) > 0 && activityUsage?.reported === activityUsage?.reasoningReported,
          cacheReadReported:
            (activityUsage?.reported ?? 0) > 0 && activityUsage?.reported === activityUsage?.cacheReadReported,
          cacheWriteReported:
            (activityUsage?.reported ?? 0) > 0 && activityUsage?.reported === activityUsage?.cacheWriteReported,
          tokens: tokens(activityUsage),
        }
      : null,
    totals: totalUsage?.calls ? recordedTotals : legacyTotals,
    totalsReasoningReported:
      !legacyCoverage && (totalUsage?.reported ?? 0) > 0 && totalUsage?.reported === totalUsage?.reasoningReported,
    totalsCacheReadReported:
      !legacyCoverage && (totalUsage?.reported ?? 0) > 0 && totalUsage?.reported === totalUsage?.cacheReadReported,
    totalsCacheWriteReported:
      !legacyCoverage && (totalUsage?.reported ?? 0) > 0 && totalUsage?.reported === totalUsage?.cacheWriteReported,
    totalCalls: totalUsage?.calls ?? 0,
    unknownCalls: (totalUsage?.calls ?? 0) - (totalUsage?.reported ?? 0),
    coverage: legacyCoverage || (totalUsage?.calls ?? 0) > (totalUsage?.reported ?? 0) ? "partial" : "recorded",
  }
  if (!services) {
    missing.push("runtime_unavailable")
    return result
  }
  const session = SessionInfo.fromRow(row)
  const selected =
    input.providerID && input.modelID
      ? {
          ...session,
          agent: input.agent ? AgentV2.ID.make(input.agent) : session.agent,
          model: {
            providerID: ProviderV2.ID.make(input.providerID),
            id: ModelV2.ID.make(input.modelID),
            variant: ModelV2.VariantID.make(input.variant ?? "default"),
          },
        }
      : session
  const source = { fingerprint: "" }
  const observed = yield* Effect.gen(function* () {
    const agent = yield* services.agents.select(selected.agent)
    const resolved = yield* services.models.resolve(selected)
    const model = resolved.model
    const protocol =
      resolved.info && resolved.provider ? resolveModelProtocol(resolved.info, resolved.provider).protocol : undefined
    const system = yield* SessionContextEpoch.observe(
      db,
      loadPromptContext(services, agent, selected, resolved.info?.capabilities.tools),
      sessionID,
      agent.id,
    )
    const entries = yield* SessionHistory.entriesForRunner(db, sessionID, system.baselineSeq)
    const context = entries.map((entry) => entry.message)
    if (input.draft)
      context.push(
        new SessionMessage.User({
          id: SessionMessage.ID.make("msg_context_preview_draft"),
          type: "user",
          text: input.draft,
          time: { created: DateTime.makeUnsafe(result.observedAt) },
          model: { providerID: ProviderV2.ID.make(String(model.provider)), id: ModelV2.ID.make(String(model.id)) },
        }),
      )
    if (input.hasAttachments || context.some((message) => message.type === "user" && message.files?.length))
      missing.push("attachments")
    if (context.some((message) => message.type === "compaction" && "remote" in message && message.remote))
      missing.push("remote_compaction")
    if (
      context.some(
        (message) =>
          message.type === "assistant" &&
          message.content.some(
            (part) =>
              part.type === "tool" &&
              part.state.status === "completed" &&
              part.state.content.some((item) => item.type === "file"),
          ),
      )
    )
      missing.push("tool_artifacts")
    if (context.some((message) => message.type === "user" && message.format)) missing.push("structured_output")
    if (system.blocked) missing.push("system_replacement_blocked")
    const materialized = yield* services.tools.materialize({
      rulesets: [agent.info?.permissions ?? [], selected.permissions, PlanningPermissions.forAgent(agent.id)],
      allowedToolIDs: agent.id === "plan" ? PlanningPermissions.allowedTools : undefined,
    })
    const lastUser = context.findLast((item) => item.type === "user")
    const finalizer = lastUser?.metadata?.deepagent_code_task_finalizer === true
    const definitions = finalizer || resolved.info?.capabilities.tools === false ? [] : materialized.definitions
    const deepagent = services.gateway.active
      ? yield* buildDeepAgentPrompt({
          runtime: services.gateway,
          sessionID,
          userMessageID: context.findLast((item) => item.type === "user")?.id ?? "preview",
          providerID: String(model.provider),
          modelID: String(model.id),
          directory: input.directory,
          messages: context,
          tools: definitions,
          git: services.git,
          observe: true,
          validationCommands: AgentGateway.DeepAgentValidation.inferValidationCommands(
            AgentGateway.DeepAgentValidation.detectValidationSignals(input.directory),
          ),
        })
      : undefined
    missing.push(...(deepagent?.missingSources ?? []))
    const plan = deepagent
      ? undefined
      : buildGovernedPlanContext({ runtime: services.gateway, sessionID, messages: context, observe: true })
    const projection = SessionHistoryProjection.projectForModel(
      context.filter((message) => message.type !== "compaction" || !message.remote),
      {
        reasoningKeep:
          protocol === "openai.responses" ||
          protocol === "openai-compatible.responses" ||
          protocol === "openai-compatible.chat"
            ? 0
            : undefined,
        reasoningContinuation: SessionHistoryProjection.requiresReasoningContinuation(String(model.provider), protocol),
      },
    )
    const selection = yield* db
      .select({ id: SessionContextSelectionTable.selection_id })
      .from(SessionContextSelectionTable)
      .where(eq(SessionContextSelectionTable.session_id, sessionID))
      .orderBy(desc(SessionContextSelectionTable.created_at))
      .get()
      .pipe(Effect.orDie)
    const { SessionRunnerCanonical } = yield* Effect.promise(() => import("./runner/canonical-turn"))
    const evidence = selection ? yield* SessionRunnerCanonical.selectionGraphEvidence(db, selection.id) : undefined
    const volatile: string[] = [...system.updates]
    const checkpoint = entries.findLast(
      (entry) => entry.message.type === "compaction" && entry.message.reason === "hard_gate",
    )?.message
    if (checkpoint?.type === "compaction" && checkpoint.checkpointID && checkpoint.checkpointHash) {
      const { LongContext } = yield* Effect.promise(() => import("./long-context"))
      const content = yield* LongContext.assertCheckpoint(
        db,
        sessionID,
        checkpoint.checkpointID,
        checkpoint.checkpointHash,
      )
      volatile.push(
        `Context checkpoint (durable authority references; revalidate before acting):\n${CanonicalJson.stringify(content)}`,
      )
    }
    const admitted = activity
      ? yield* db
          .select({ prompt: SessionInputTable.prompt })
          .from(SessionInputTable)
          .where(eq(SessionInputTable.id, SessionMessage.ID.make(activity.trigger_input_id)))
          .get()
          .pipe(Effect.orDie)
      : undefined
    const approval = Schema.decodeUnknownOption(
      Schema.Struct({ documentID: Schema.String, planID: Schema.String, version: Schema.Int, hash: Schema.String }),
    )(admitted?.prompt.metadata?.dac_plan_approval)
    if (Option.isSome(approval))
      volatile.push(
        `This activity executes the exact user-approved plan ${approval.value.planID}, document ${approval.value.documentID}, version ${approval.value.version}, SHA256 ${approval.value.hash}, carried in its original execution request. Current plan-status and any later draft shown below are observations of progress, not a replacement authorization. Do not expand the approved scope from a later draft; ask the user for a separate approval if scope changes.`,
      )
    if (evidence) volatile.push(evidence)
    const request = LLM.request({
      model,
      providerOptions: {
        openai: { promptCacheKey: /^ses_[0-9a-f]{64}$/.test(sessionID) ? sessionID.slice(4) : sessionID },
      },
      system: PreparedProviderTurn.mergeSystemParts([agent.info?.system], deepagent?.stableSystemParts ?? [], [
        system.baseline,
      ]).map(SystemPart.make),
      messages: [
        ...toLLMMessages(projection.messages, model),
        ...volatile.map(Message.system),
        ...(deepagent?.volatileRoundContext
          ? [Message.user(deepagent.volatileRoundContext)]
          : plan
            ? [Message.user(plan)]
            : []),
      ],
      tools: definitions,
      toolChoice: finalizer ? "none" : undefined,
      metadata: {
        "deepagent-code": {
          callKind: "session_turn",
          feature: "v2_session_chat",
          sessionID,
          messageID: context.findLast((item) => item.type === "user")?.id ?? "preview",
          agent: agent.id,
        },
      },
    })
    source.fingerprint = Hash.sha256(
      CanonicalJson.stringify({
        system: request.system,
        history: request.messages,
        tools: request.tools,
        permissions: [agent.info?.permissions, selected.permissions],
        model: {
          id: model.id,
          provider: model.provider,
          protocol,
          limits: model.route.defaults.limits,
          generation: model.route.defaults.generation,
          origin: URL.parse(model.route.endpoint.baseURL ?? "")?.origin ?? null,
        },
        selection: selection?.id,
        draftRevision: input.draftRevision,
      }),
    )
    // Selection evidence is bounded to 4KiB; loop/budget controls are short. This is a K-level
    // observation, not admission: allow one KiToken for changing retrieval/control text.
    const estimated = PreparedProviderTurn.estimateFullRequestTokens(request) + 1_024
    const budget = PreparedProviderTurn.budget(model, estimated, request.generation?.maxTokens)
    return {
      status: missing.length ? ("partial" as const) : ("complete" as const),
      inputTokens: estimated,
      contextLimit: resolved.info?.limit.context ?? model.route.defaults.limits?.context ?? null,
      inputLimit: resolved.info?.limit.input ?? model.route.defaults.limits?.input ?? null,
      physicalInputBudget: budget.provenance === "model_limit" ? budget.physicalInputBudget : null,
      reservedOutput: budget.reservedOutputTokens,
      modelID: String(model.id),
      providerID: String(model.provider),
      draftRevision: input.draftRevision,
      missing,
    }
  }).pipe(Effect.option)
  if (Option.isNone(observed)) missing.push("context_unavailable")
  const latest = yield* db
    .select({ updated: SessionTable.time_updated })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  const latestHead = yield* db
    .select({ seq: max(SessionMessageTable.seq) })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  const latestEpoch = yield* db
    .select({ revision: SessionContextEpochTable.revision })
    .from(SessionContextEpochTable)
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  const estimate = Option.isSome(observed) ? observed.value : result.estimate
  return {
    ...result,
    revision: Hash.sha256(CanonicalJson.stringify([result.revision, source.fingerprint])),
    estimate:
      latest?.updated !== row.time_updated || latestHead?.seq !== head?.seq || latestEpoch?.revision !== epoch?.revision
        ? { ...estimate, status: "stale" as const }
        : estimate,
  }
})
