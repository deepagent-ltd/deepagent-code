import { Agent } from "@/agent/agent"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { McpAdapter } from "@/mcp/adapter"
import { Permission } from "@/permission"
import { PermissionV1 } from "@deepagent-code/core/v1/permission"
import { Tool } from "@/tool/tool"
import { ToolProvenance } from "@/tool/provenance"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"

import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { TaskPromptOps } from "@/tool/task"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { Cause, Effect, Exit, Result, Schema } from "effect"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"
import { Log } from "@deepagent-code/core/util/log"
import { EffectBridge } from "@/effect/bridge"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { ToolSemanticFingerprint } from "@/tool/semantic-fingerprint"
import { ContextFederationRollout } from "@deepagent-code/core/context-federation/rollout"

const log = Log.create({ service: "session.tools" })
const DEFAULT_SUBAGENT_PERMISSION_TIMEOUT_MS = 60_000

export function validatedToolInputSchema(parameters: Schema.Decoder<unknown>, wireSchema: JSONSchema7) {
  const decode = Schema.decodeUnknownResult(parameters)
  return jsonSchema<Record<string, unknown>>(wireSchema, {
    validate(input) {
      const result = decode(input)
      if (Result.isFailure(result)) {
        return { success: false, error: new Error(result.failure.toString(), { cause: result.failure }) }
      }
      // Tool.define owns the canonical decode at execution time. Returning its decoded value here
      // would apply Effect Schema transformations twice (for example NumberFromString).
      return { success: true, value: input as Record<string, unknown> }
    },
  })
}

export function mcpResultError(
  toolName: string,
  result: { isError?: boolean; content: ReadonlyArray<{ type: string; text?: string }> },
) {
  if (!result.isError) return
  const message = result.content
    .flatMap((item) => (item.type === "text" && typeof item.text === "string" ? [item.text] : []))
    .join("\n\n")
    .trim()
  return new Error(message || `MCP tool ${toolName} returned an error`)
}

export function executeWithPermissionAuthority<A, E, R>(input: {
  readonly permission: Permission.Interface
  readonly context: Tool.Context
  readonly toolName: string
  readonly execute: Effect.Effect<A, E, R>
}): Effect.Effect<A, E, R> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const effects = input.permission.effectsForToolCall
        ? yield* input.permission.effectsForToolCall({
            sessionID: input.context.sessionID,
            toolMessageID: input.context.messageID,
            toolCallID: input.context.callID ?? "",
            toolName: input.toolName,
          })
        : []
      if (effects.length) {
        const unsettled = effects.find((item) => item.state !== "settled")
        if (unsettled)
          return yield* Effect.die(
            new Error(
              `Permission effect ${unsettled.receiptID} is ${unsettled.state}; external side effect replay is unsafe`,
            ),
          )
        const terminal = effects[0]!
        if (terminal.outcome === "failure")
          return yield* Effect.die(
            new Error(
              typeof terminal.result === "object" && terminal.result && "message" in terminal.result
                ? String(terminal.result.message)
                : "Previously settled permission effect failed",
            ),
          )
        return terminal.result as A
      }
      const attempted = yield* restore(input.execute).pipe(Effect.exit)
      if (Exit.isFailure(attempted)) {
        if (Cause.hasInterrupts(attempted.cause)) {
          yield* quarantinePermissionEffects(input.permission, input.context, input.toolName)
          return yield* Effect.failCause(attempted.cause)
        }
        const settled = yield* restore(
          settlePermissionEffects(input.permission, input.context, "failure", {
            message: Cause.pretty(attempted.cause),
          }),
        ).pipe(Effect.exit)
        if (Exit.isFailure(settled)) {
          yield* quarantinePermissionEffects(input.permission, input.context, input.toolName)
        }
        return yield* Effect.failCause(attempted.cause)
      }
      const settled = yield* restore(
        settlePermissionEffects(input.permission, input.context, "success", attempted.value),
      ).pipe(Effect.exit)
      if (Exit.isFailure(settled)) {
        yield* quarantinePermissionEffects(input.permission, input.context, input.toolName)
        return yield* Effect.failCause(settled.cause)
      }
      return attempted.value
    }),
  )
}

export function executeWithHostPermissionAdmission<A, E, R>(input: {
  readonly context: Tool.Context
  readonly request?: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">
  readonly admissionKey?: string
  readonly execute: Effect.Effect<A, E, R>
}) {
  return Effect.gen(function* () {
    if (input.request) yield* input.context.ask(input.request)
    if (input.admissionKey) input.context.hostPermissionAdmissions?.add(input.admissionKey)
    return yield* input.execute
  })
}

function quarantinePermissionEffects(permission: Permission.Interface, context: Tool.Context, toolName: string) {
  return Effect.gen(function* () {
    const queried = permission.effectsForToolCall
      ? yield* permission
          .effectsForToolCall({
            sessionID: context.sessionID,
            toolMessageID: context.messageID,
            toolCallID: context.callID ?? "",
            toolName,
          })
          .pipe(Effect.exit)
      : undefined
    const ownerIDs = queried
      ? Exit.isSuccess(queried)
        ? queried.value.length > 0
          ? queried.value.filter((effect) => effect.state === "started").map((effect) => effect.ownerID)
          : (context.permissionEffectGrants ?? []).map((grant) => grant.ownerID)
        : (context.permissionEffectGrants ?? []).map((grant) => grant.ownerID)
      : (context.permissionEffectGrants ?? []).map((grant) => grant.ownerID)
    const uniqueOwnerIDs = [...new Set(ownerIDs)]
    if (!uniqueOwnerIDs.length) return
    if (!permission.rotateOwnerIfCurrent) {
      return yield* Effect.die(new Error("permission effect recovery authority is unavailable"))
    }
    yield* Effect.forEach(uniqueOwnerIDs, permission.rotateOwnerIfCurrent, { discard: true })
  })
}

function settlePermissionEffects(
  permission: Permission.Interface,
  context: Tool.Context,
  outcome: "success" | "failure",
  result: unknown,
) {
  return Effect.forEach(
    context.permissionEffectGrants ?? [],
    (grant) =>
      permission.settleEffect
        ? permission.settleEffect({ grant, outcome, result })
        : Effect.die(new Error("permission effect settlement service is unavailable")),
    { discard: true },
  )
}

// U1 PlanController gate: a HookPolicy with the before_tool_use plan gate. The current policy lets
// tools execute and keeps stale-plan warnings in runtime logs; finalization owns plan enforcement.
// The defensive block path remains for a future safety hook that explicitly denies execution.
const PlanHook = new AgentGateway.DeepAgentHooks.HookPolicy().on(
  "before_tool_use",
  AgentGateway.DeepAgentHooks.planGate(),
)

// M7 (S1-v3.4): pull SQL-bearing string args out of an MCP DB tool call so the read-only guard can
// vet them. This is a HEURISTIC keyed to known Postgres-MCP tool shapes, NOT a general interceptor:
// it scans a known set of arg key names (servers name the query arg `sql`/`query`/`statement`/… )
// and recurses one level into nested objects/arrays (some servers wrap args as `{params:{sql:…}}`).
// The real first-layer enforcement is the server's own `--access-mode=restricted`; this is
// defense-in-depth. A server that names its SQL arg something exotic would slip past — acceptable
// because the server is still read-only-constrained, and anything not provably read-only that DOES
// reach the guard is rejected (fail-closed). Non-string / absent → nothing to guard.
const SQL_ARG_KEYS = new Set(["sql", "query", "statement", "queries", "sql_query", "command", "text"])
const SQL_SCAN_MAX_DEPTH = 3
function extractSqlArgs(args: Record<string, unknown>): string[] {
  const out: string[] = []
  const visit = (value: unknown, keyMatches: boolean, depth: number): void => {
    if (depth > SQL_SCAN_MAX_DEPTH) return
    if (typeof value === "string") {
      if (keyMatches && value.trim().length > 0) out.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const e of value) visit(e, keyMatches, depth + 1)
      return
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        visit(v, keyMatches || SQL_ARG_KEYS.has(k), depth + 1)
      }
    }
  }
  visit(args, false, 0)
  return out
}

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  bypassAgentCheck: boolean
  messages: SessionV1.WithParts[]
  promptOps: TaskPromptOps
  contextFederationRollout?: ContextFederationRollout.Decision
}) {
  using _ = log.time("resolveTools")
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const truncate = yield* Truncate.Service
  const flags = yield* RuntimeFlags.Service

  const context = (args: Record<string, unknown>, options: ToolExecutionOptions, toolName: string): Tool.Context => {
    const permissionEffectGrants: Permission.EffectGrant[] = []
    const hostPermissionAdmissions = new Set<string>()
    return {
      sessionID: input.session.id,
      abort: options.abortSignal!,
      messageID: input.processor.message.id,
      callID: options.toolCallId,
      extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps },
      agent: input.agent.name,
      messages: input.messages,
      permissionEffectGrants,
      hostPermissionAdmissions,
      metadata: (val) =>
        input.processor.updateToolCall(options.toolCallId, (match) => {
          if (!["running", "pending"].includes(match.state.status)) return match
          return {
            ...match,
            state: {
              title: val.title,
              metadata: val.metadata,
              status: "running",
              input: args,
              time: { start: Date.now() },
            },
          }
        }),
      ask: (req) =>
        permission.askEffect
          ? permission
              .askEffect({
                ...req,
                sessionID: input.session.id,
                tool: { messageID: input.processor.message.id, callID: options.toolCallId },
                effectToolName: toolName,
                ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
                ...(input.session.parentID
                  ? { timeoutMs: flags.subagentPermissionTimeoutMs ?? DEFAULT_SUBAGENT_PERMISSION_TIMEOUT_MS }
                  : {}),
              })
              .pipe(
                Effect.tap((grant) =>
                  Effect.sync(() => {
                    if (grant && !permissionEffectGrants.some((item) => item.receiptID === grant.receiptID))
                      permissionEffectGrants.push(grant)
                  }),
                ),
                Effect.asVoid,
                Effect.orDie,
              )
          : permission
              .ask({
                ...req,
                sessionID: input.session.id,
                tool: { messageID: input.processor.message.id, callID: options.toolCallId },
                ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
                ...(input.session.parentID
                  ? { timeoutMs: flags.subagentPermissionTimeoutMs ?? DEFAULT_SUBAGENT_PERMISSION_TIMEOUT_MS }
                  : {}),
              })
              .pipe(Effect.orDie),
    }
  }

  // Shared plan-gate chokepoint (U1 soft gate + U9 hard gate). BOTH the builtin loop AND the MCP loop
  // must run this: a mutating tool of EITHER kind that is not bound to a fresh plan step has to be gated,
  // otherwise the model can route all mutations through MCP tools while the plan latch is stale and the
  // gate is a silent no-op. Returns a directive the caller applies: "block" → return a soft
  // tool-result WITHOUT executing; "pass" → execute normally. Soft warnings are deduplicated and
  // written only to the process log, never to provider-visible or durable conversation content.
  // `isMutating` is supplied by the caller (builtin: classifier on the command; MCP: risk tier).
  type GateDirective = { kind: "block"; output: string } | { kind: "pass" }
  const evaluatePlanGate = (sessionID: string, isMutating: boolean): GateDirective => {
    const latch = AgentGateway.DeepAgentSessionState.planLatch(sessionID)
    const planStale = latch?.latch === "stale" && !AgentGateway.DeepAgentPlanController.shouldEscapeToHuman(latch)
    // Gate strength must key off THIS session's EFFECTIVE mode, not the process-global one. The global
    // `snapshot().agentMode` ignores the per-request `agent_mode_override` (a downgraded subagent, or a
    // session pinned below the global) — so it would over- or under-gate a turn, and disagree with
    // finalize (which uses the run's mode). The per-session run-state mode IS the effective mode
    // (ensureSessionStateForRun seeds it from run.agentMode = effectiveAgentMode(...)); fall back to the
    // global snapshot only before session state exists.
    const agentMode =
      AgentGateway.DeepAgentSessionState.get(sessionID)?.mode ?? AgentGateway.snapshot().agentMode ?? "high"
    const lightweight = AgentGateway.DeepAgentPlanController.isLightweightMode(agentMode)
    const hardGate = !lightweight && AgentGateway.DeepAgentPlanController.hardGateEnabled(agentMode)
    const plan = AgentGateway.DeepAgentSessionState.getPlan(sessionID)
    const gateDecision = PlanHook.evaluate({
      name: "before_tool_use",
      payload: {
        planStale,
        staleReason: latch?.stale_reason ?? null,
        isMutating,
        lightweight,
        hardGate,
        // planExists guards the per-step-binding nudge: a run that never created a plan has no step to
        // bind to, so it must not be nagged (mirrors stopHookGate's planExists guard).
        planExists: plan != null,
        hasActiveStep: AgentGateway.DeepAgentPlanController.hasActiveStep(plan),
      },
    })
    // DEFENSIVE: planGate never returns "block" anymore (plan discipline is warn-only at the tool call;
    // enforcement lives at finalization). We keep this branch only so a FUTURE safety hook that returns
    // "block" still fails closed. recordPlanGateBlock is retained for that path's telemetry.
    if (gateDecision.decision === "block") {
      AgentGateway.DeepAgentSessionState.recordPlanGateBlock(sessionID)
      const output =
        latch?.stale_reason != null
          ? `The plan is stale (${latch.stale_reason}). ${gateDecision.blockReason}. Call the \`plan\` tool to update your plan, then retry this edit.`
          : `${gateDecision.blockReason}. Call the \`plan\` tool first.`
      return { kind: "block", output }
    }
    const gateWarnReason = gateDecision.decision === "warn" && !lightweight ? gateDecision.blockReason : undefined
    // A mutating tool that actually executes is forward progress → reset the consecutive-block counter.
    if (isMutating) {
      AgentGateway.DeepAgentSessionState.recordMutation(sessionID)
      AgentGateway.DeepAgentSessionState.resetPlanGateBlocks(sessionID)
    }
    if (!gateWarnReason) return { kind: "pass" }
    const fingerprint = JSON.stringify([
      latch?.plan_id ?? null,
      latch?.latch ?? null,
      latch?.stale_reason ?? null,
      latch?.replan_count ?? 0,
      plan?.active_step_id ?? null,
      AgentGateway.DeepAgentSessionState.get(sessionID)?.lastAdmissionUserMessageId ?? null,
      gateWarnReason,
    ])
    if (AgentGateway.DeepAgentSessionState.claimPlanGateNudge(sessionID, fingerprint)) {
      log.info("plan gate warning", { sessionID, reason: gateWarnReason })
    }
    return { kind: "pass" }
  }

  for (const item of yield* registry.tools({
    modelID: ModelV2.ID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
    projectScopeKey: input.session.projectID,
    contextFederationRollout: input.contextFederationRollout,
  })) {
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    const aiToolDef: AITool = tool({
      description: item.description,
      inputSchema: validatedToolInputSchema(item.parameters, schema),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            const ctx = context(args, options, item.id)
            return yield* executeWithPermissionAuthority({
              permission,
              context: ctx,
              toolName: item.id,
              execute: executeWithHostPermissionAdmission({
                context: ctx,
                ...(item.provenance?.source === "custom"
                  ? {
                      admissionKey: item.id,
                      request: {
                        permission: item.id,
                        patterns: ["*"],
                        metadata: { args },
                        always: ["*"],
                      },
                    }
                  : {}),
                execute: Effect.gen(function* () {
                  yield* plugin.trigger(
                    "tool.execute.before",
                    { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
                    { args },
                  )
                  // U1 soft gate + U9 hard gate via the shared chokepoint. Read-only shell commands
                  // (ls/cat/grep/git status/curl probe/…) are the agent's eyes and must never be gated — pass
                  // the command string so the classifier can exempt them. Any ambiguity → mutating (fail-safe).
                  // Non-shell tools ignore the command arg.
                  const command =
                    (item.id === "bash" || item.id === "shell") &&
                    typeof (args as { command?: unknown } | undefined)?.command === "string"
                      ? (args as { command: string }).command
                      : null
                  // Fail SAFE if the classifier ever throws (it is total today — pure regex/string ops — but a
                  // future regex/refactor could introduce a throw): treat an unclassifiable command as mutating
                  // so it is gated, rather than letting the exception abort the whole turn.
                  let isMutating: boolean
                  try {
                    isMutating = AgentGateway.DeepAgentPlanController.isMutatingTool(item.id, command)
                  } catch {
                    isMutating = true
                  }
                  const gate = evaluatePlanGate(ctx.sessionID, isMutating)
                  if (gate.kind === "block") {
                    return { title: "Plan update required", output: gate.output, metadata: {} }
                  }
                  const result = yield* item.execute(args, ctx).pipe(
                    // I33-2: any tool execution failure marks the plan stale (tool_failed reason).
                    // Finalization and the next runtime-system boundary enforce that state; tool output
                    // remains exclusively the tool's real result.
                    Effect.tapError(() =>
                      Effect.sync(() => AgentGateway.DeepAgentSessionState.markPlanStale(ctx.sessionID, "tool_failed")),
                    ),
                  )
                  const output = {
                    ...result,
                    attachments: result.attachments?.map((attachment) => ({
                      ...attachment,
                      id: PartID.ascending(),
                      sessionID: ctx.sessionID,
                      messageID: input.processor.message.id,
                    })),
                  }
                  yield* plugin.trigger(
                    "tool.execute.after",
                    { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
                    output,
                  )
                  if (options.abortSignal?.aborted) {
                    yield* input.processor.completeToolCall(options.toolCallId, output)
                  }
                  return output
                }),
              }),
            })
          }),
          options.abortSignal,
        )
      },
    })
    // M2 (S1-v3.4): carry the registry's explicit provenance onto the freshly
    // built AI SDK tool so request.ts reads it instead of guessing from the name.
    if (item.provenance) ToolProvenance.set(aiToolDef, item.provenance)
    if (item.semanticFingerprint) ToolSemanticFingerprint.set(aiToolDef, item.semanticFingerprint)
    if (item.resultFingerprint) ToolSemanticFingerprint.setResult(aiToolDef, item.resultFingerprint)
    tools[item.id] = aiToolDef
  }

  for (const [key, item] of Object.entries(yield* mcp.tools())) {
    const execute = item.execute
    if (!execute) continue

    // M7 (S1-v3.4): derive the per-call permission action from the server's risk tier (carried via
    // provenance, which mcp/index.ts now sets from a catalog-MATCH of the live config, not a forgeable
    // persisted flag). read_only → auto-allow; every other tier, AND any tier-less / non-matching
    // server, fails closed to `ask`. The `mcpReadOnlyAutoAllow` flag (default ON) can be set =false to
    // force EVERY MCP tool through ctx.ask — restoring the pre-M7 always-ask behavior as an escape hatch.
    const provenance = ToolProvenance.get(item)
    const tier = McpAdapter.resolveToolRisk(provenance?.riskTier)
    const gateAction =
      tier === "read_only" && !flags.mcpReadOnlyAutoAllow ? "ask" : McpAdapter.defaultPermissionForTier(tier)
    // A read_only DB server still gets a second, fail-closed lexical SQL guard on its query args:
    // even auto-allowed, a statement that is not provably read-only is rejected before execution.
    const isReadOnlyDb = provenance?.riskTier === "read_only"

    const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
    const transformed = ProviderTransform.schema(input.model, schema)
    item.inputSchema = jsonSchema(transformed)
    item.execute = (args, opts) =>
      run.promise(
        Effect.gen(function* () {
          const ctx = context(args, opts, key)
          return yield* executeWithPermissionAuthority({
            permission,
            context: ctx,
            toolName: key,
            execute: executeWithHostPermissionAdmission({
              context: ctx,
              ...(gateAction === "allow"
                ? {}
                : { request: { permission: key, metadata: {}, patterns: ["*"], always: ["*"] } }),
              execute: Effect.gen(function* () {
                // M7 read-only SQL guard: for a read_only server, reject any SQL-bearing arg that is not
                // provably read-only (defense-in-depth atop the server's own --access-mode=restricted).
                if (isReadOnlyDb) {
                  for (const sqlArg of extractSqlArgs(args)) {
                    const verdict = McpAdapter.assertReadOnlySql(sqlArg)
                    if (!verdict.allowed) {
                      return {
                        title: "",
                        metadata: { error: true, riskTier: "read_only", reason: verdict.reason },
                        output: `Rejected by read-only DB guard: ${verdict.reason}`,
                        attachments: [],
                        content: [{ type: "text" as const, text: `Rejected by read-only DB guard: ${verdict.reason}` }],
                      }
                    }
                  }
                }
                // Plan gate for MCP tools (parity with the builtin path). An MCP tool whose risk tier is not
                // `read_only` mutates external state (fs write, DB write, shell exec), so it must be gated like
                // a builtin mutating tool — otherwise a stale plan's gate is silently bypassed via MCP. A
                // read_only tier is the agent's eyes (exempt), mirroring read-only shell commands.
                const mcpIsMutating = tier !== "read_only"
                const mcpGate = evaluatePlanGate(ctx.sessionID, mcpIsMutating)
                if (mcpGate.kind === "block") {
                  return {
                    title: "Plan update required",
                    metadata: {},
                    output: mcpGate.output,
                    attachments: [],
                    content: [{ type: "text" as const, text: mcpGate.output }],
                  }
                }
                yield* plugin.trigger(
                  "tool.execute.before",
                  { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
                  { args },
                )
                const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
                  return yield* Effect.promise(() => execute(args, opts))
                }).pipe(
                  Effect.withSpan("Tool.execute", {
                    attributes: {
                      "tool.name": key,
                      "tool.call_id": opts.toolCallId,
                      "session.id": ctx.sessionID,
                      "message.id": input.processor.message.id,
                    },
                  }),
                )
                const executionError = mcpResultError(key, result)
                if (executionError) return yield* Effect.fail(executionError)
                yield* plugin.trigger(
                  "tool.execute.after",
                  { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
                  result,
                )

                const textParts: string[] = []
                const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []
                for (const contentItem of result.content) {
                  if (contentItem.type === "text") textParts.push(contentItem.text)
                  else if (contentItem.type === "image") {
                    attachments.push({
                      type: "file",
                      mime: contentItem.mimeType,
                      url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
                    })
                  } else if (contentItem.type === "resource") {
                    const { resource } = contentItem
                    if (resource.text) textParts.push(resource.text)
                    if (resource.blob) {
                      attachments.push({
                        type: "file",
                        mime: resource.mimeType ?? "application/octet-stream",
                        url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                        filename: resource.uri,
                      })
                    }
                  }
                }

                const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)
                const metadata = {
                  ...result.metadata,
                  truncated: truncated.truncated,
                  ...(truncated.truncated && { outputPath: truncated.outputPath }),
                }

                const output = {
                  title: "",
                  metadata,
                  output: truncated.content,
                  attachments: attachments.map((attachment) => ({
                    ...attachment,
                    id: PartID.ascending(),
                    sessionID: ctx.sessionID,
                    messageID: input.processor.message.id,
                  })),
                  content: result.content,
                }
                if (opts.abortSignal?.aborted) {
                  yield* input.processor.completeToolCall(opts.toolCallId, output)
                }
                return output
              }),
            }),
          })
        }),
        opts.abortSignal,
      )
    tools[key] = item
  }

  return tools
})

export * as SessionTools from "./tools"
