import { Agent } from "@/agent/agent"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { McpAdapter } from "@/mcp/adapter"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { ToolProvenance } from "@/tool/provenance"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"

import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { TaskPromptOps } from "@/tool/task"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import { Effect } from "effect"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"
import { Log } from "@deepagent-code/core/util/log"
import { EffectBridge } from "@/effect/bridge"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"

const log = Log.create({ service: "session.tools" })

// U1 PlanController soft gate: a HookPolicy with the before_tool_use plan gate. While the runtime
// has flagged the plan as stale, mutating tools (write/edit/patch/shell) are soft-blocked until the
// model calls `plan` to update it; read/diagnosis/`todowrite`/`plan` always pass. Lightweight modes
// (general/direct) only warn. Evaluated at the per-tool dispatch chokepoint below.
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

  const context = (args: Record<string, unknown>, options: ToolExecutionOptions): Tool.Context => ({
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps },
    agent: input.agent.name,
    messages: input.messages,
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
      permission
        .ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
        })
        .pipe(Effect.orDie),
  })

  for (const item of yield* registry.tools({
    modelID: ModelV2.ID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
  })) {
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    const aiToolDef: AITool = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            const ctx = context(args, options)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
              { args },
            )
            // U1 soft gate: if the runtime flagged the plan stale, soft-block mutating tools so the
            // model must call `plan` to update it first. We return a soft tool-result (not a throw)
            // matching the "rewrite your input" feedback model — read/diagnosis/`plan` pass through,
            // and the escape hatch (too many replans -> needs_human) is honored via planStale.
            const latch = AgentGateway.DeepAgentSessionState.planLatch(ctx.sessionID)
            const planStale =
              latch?.latch === "stale" && !AgentGateway.DeepAgentPlanController.shouldEscapeToHuman(latch)
            const agentMode = AgentGateway.snapshot().agentMode ?? "high"
            const lightweight = AgentGateway.DeepAgentPlanController.isLightweightMode(agentMode)
            // U9 hard gate (high+ only, never lightweight): a mutating tool must be bound to an active
            // plan step. high warns + auto-replans; xhigh/max/ultra hard-block.
            const hardGate = !lightweight && AgentGateway.DeepAgentPlanController.hardGateEnabled(agentMode)
            const plan = AgentGateway.DeepAgentSessionState.getPlan(ctx.sessionID)
            const gateDecision = PlanHook.evaluate({
              name: "before_tool_use",
              payload: {
                planStale,
                isMutating: AgentGateway.DeepAgentPlanController.isMutatingTool(item.id),
                lightweight,
                hardGate,
                hasActiveStep: AgentGateway.DeepAgentPlanController.hasActiveStep(plan),
                hardGateMissBlocks: hardGate && AgentGateway.DeepAgentPlanController.hardGateStrict(agentMode),
              },
            })
            if (gateDecision.decision === "block") {
              const reason =
                latch?.stale_reason != null
                  ? `The plan is stale (${latch.stale_reason}). ${gateDecision.blockReason}. Call the \`plan\` tool to update your plan, then retry this edit.`
                  : `${gateDecision.blockReason}. Call the \`plan\` tool first.`
              return { title: "Plan update required", output: reason, metadata: {} }
            }
            const result = yield* item.execute(args, ctx)
            // U10: count a successful mutating tool call toward the progress-nudge budget. Only
            // mutating tools (edit/write/patch/shell) count; the counter resets when the model next
            // changes a plan step's status. No-op when there is no plan.
            if (AgentGateway.DeepAgentPlanController.isMutatingTool(item.id)) {
              AgentGateway.DeepAgentSessionState.recordMutation(ctx.sessionID)
            }
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
        )
      },
    })
    // M2 (S1-v3.4): carry the registry's explicit provenance onto the freshly
    // built AI SDK tool so request.ts reads it instead of guessing from the name.
    if (item.provenance) ToolProvenance.set(aiToolDef, item.provenance)
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
          const ctx = context(args, opts)
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
          yield* plugin.trigger(
            "tool.execute.before",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
            { args },
          )
          const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
            // read_only tier → auto-allow (no prompt); all other tiers + tier-less → ask (fail-closed).
            if (gateAction !== "allow") {
              yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
            }
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
      )
    tools[key] = item
  }

  return tools
})

export * as SessionTools from "./tools"
