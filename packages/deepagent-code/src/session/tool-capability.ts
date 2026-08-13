/**
 * SessionToolCapability — pure capability snapshot for subagent admission.
 *
 * Design: subagent-control-plane-design.zh-CN.md §2.2.1, §3.1 (TaskAdmission)
 *
 * This module is a pure read-only projection of already-loaded state.
 * It MUST NOT:
 *   - call tool.definition hooks
 *   - execute any plugin hook
 *   - connect to MCP servers or refresh remote tool lists
 *   - construct or mutate any Session
 *
 * The snapshot is used at admission time to freeze mutation_capability and
 * workspace policy, and at start time for security revalidation.
 */

import { Data, Effect } from "effect"
import { Hash } from "@deepagent-code/core/util/hash"
import { isMutatingTool } from "@deepagent-code/core/deepagent/plan-controller"
import { ToolRegistry } from "@/tool/registry"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { Plugin } from "@/plugin"
import type { Hooks } from "@deepagent-code/plugin"

// ---------------------------------------------------------------------------
// Public types
// Design: §2.2.1
// ---------------------------------------------------------------------------

export type ToolCapability = {
  readonly toolID: string
  readonly source: "builtin" | "custom" | "mcp"
  readonly definitionHash: string
  readonly workspaceMutation: "never" | "possible"
  readonly permissionKeys: ReadonlyArray<string>
  readonly hostEnforced: boolean
  readonly evidence: string
}

export type RuntimeInterceptorCapability = {
  readonly pluginID: string
  readonly hook: keyof Hooks
  readonly phase: "input" | "provider" | "command" | "tool" | "shell" | "compaction" | "event" | "lifecycle" | "other"
  readonly taskReachable: boolean
  readonly workspaceBinding: "child_location" | "parent_location" | "global" | "not_applicable"
  readonly workspaceMutation: "never" | "possible"
  readonly hostEnforced: boolean
  readonly evidence: string
}

export type ToolCapabilitySnapshot = {
  readonly tools: ReadonlyArray<ToolCapability>
  readonly interceptors: ReadonlyArray<RuntimeInterceptorCapability>
  readonly enabledToolIDs: ReadonlyArray<string>
  readonly hash: string
}

export type PluginCapabilityDescriptor = {
  readonly pluginID: string
  readonly schemaVersion: 1
  readonly hooks: ReadonlyArray<PluginHookDescriptor>
  readonly evidence: string
}

export type PluginHookDescriptor = {
  readonly hook: keyof Hooks
  readonly phase: "input" | "provider" | "command" | "tool" | "shell" | "compaction" | "event" | "lifecycle" | "other"
  readonly taskReachable: boolean
  readonly workspaceBinding: "child_location" | "parent_location" | "global" | "not_applicable"
  readonly workspaceMutation: "never" | "possible"
  readonly hostEnforced: boolean
}

export class ToolIDCollisionError extends Data.TaggedError("ToolCapability.ToolIDCollisionError")<{
  readonly toolID: string
  readonly sources: ReadonlyArray<string>
}> {}

// ---------------------------------------------------------------------------
// Hook profile lookup table
// Design: §2.2.1 PluginCapabilityDescriptor addendum
// ---------------------------------------------------------------------------

type HookProfile = Pick<PluginHookDescriptor, "phase" | "taskReachable" | "workspaceBinding" | "workspaceMutation" | "hostEnforced">

const HOOK_PROFILE: Partial<Record<keyof Hooks, HookProfile>> = {
  "event":                                { phase: "event",      taskReachable: true,  workspaceBinding: "global",         workspaceMutation: "possible", hostEnforced: false },
  "chat.message":                         { phase: "input",      taskReachable: true,  workspaceBinding: "global",         workspaceMutation: "possible", hostEnforced: false },
  "chat.params":                          { phase: "provider",   taskReachable: true,  workspaceBinding: "global",         workspaceMutation: "possible", hostEnforced: false },
  "chat.headers":                         { phase: "provider",   taskReachable: true,  workspaceBinding: "global",         workspaceMutation: "possible", hostEnforced: false },
  "command.execute.before":               { phase: "command",    taskReachable: true,  workspaceBinding: "child_location", workspaceMutation: "possible", hostEnforced: false },
  "shell.env":                            { phase: "shell",      taskReachable: true,  workspaceBinding: "child_location", workspaceMutation: "never",    hostEnforced: true  },
  "experimental.session.compacting":     { phase: "compaction", taskReachable: true,  workspaceBinding: "global",         workspaceMutation: "possible", hostEnforced: false },
  "experimental.compaction.autocontinue": { phase: "compaction", taskReachable: true,  workspaceBinding: "global",         workspaceMutation: "possible", hostEnforced: false },
  "experimental.text.complete":           { phase: "other",      taskReachable: true,  workspaceBinding: "global",         workspaceMutation: "possible", hostEnforced: false },
  "experimental.chat.messages.transform": { phase: "provider",   taskReachable: true,  workspaceBinding: "global",         workspaceMutation: "possible", hostEnforced: false },
  "experimental.chat.system.transform":   { phase: "provider",   taskReachable: true,  workspaceBinding: "global",         workspaceMutation: "possible", hostEnforced: false },
  "tool.definition":                      { phase: "tool",       taskReachable: true,  workspaceBinding: "child_location", workspaceMutation: "possible", hostEnforced: false },
  "tool.execute.before":                  { phase: "tool",       taskReachable: true,  workspaceBinding: "child_location", workspaceMutation: "possible", hostEnforced: false },
  "tool.execute.after":                   { phase: "tool",       taskReachable: true,  workspaceBinding: "child_location", workspaceMutation: "possible", hostEnforced: false },
}

const LIFECYCLE_HOOKS = new Set<string>(["config", "dispose"])

const UNKNOWN_HOOK_PROFILE: HookProfile = {
  phase: "other",
  taskReachable: true,
  workspaceBinding: "global",
  workspaceMutation: "possible",
  hostEnforced: false,
}

// ---------------------------------------------------------------------------
// workspace mutation classification for builtin/custom tools
// Design: §2.2.1 — isMutatingTool is the initial backfill source.
// bash/shell without command context are always "possible" at snapshot time.
// ---------------------------------------------------------------------------

function toolWorkspaceMutation(toolID: string): "never" | "possible" {
  const lower = toolID.toLowerCase()
  // bash/shell without a specific command → always "possible" at admission time
  if (lower === "bash" || lower === "shell") return "possible"
  return isMutatingTool(toolID) ? "possible" : "never"
}

// ---------------------------------------------------------------------------
// Capability snapshot implementation
// ---------------------------------------------------------------------------

/** Compute a stable SHA-256 digest of a tool definition for fingerprinting. */
function hashToolDef(id: string, description: string, schema: unknown): string {
  const canonical = JSON.stringify(
    { id, description, schema },
    Object.keys({ id, description, schema }).sort(),
  )
  return Hash.sha256(canonical)
}

/**
 * Aggregate capability snapshot from all three sources.
 * Pure read — no hooks executed, no network calls, no Session construction.
 *
 * Fails with ToolIDCollisionError if two sources expose the same provider-visible tool ID.
 */
export const SessionToolCapability = {
  snapshot(input: {
    readonly toolOverrides?: Record<string, boolean>
  } = {}) {
    return Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const mcp = yield* MCP.Service
      const plugin = yield* Plugin.Service

      // --- Builtin / custom tools from registry ---
      const registryDefs = yield* registry.all()
      const registryTools: ToolCapability[] = registryDefs.map((def) => {
        const source = def.provenance?.source ?? "builtin"
        const custom = source === "custom"
        return {
          toolID: def.id,
          source: source === "mcp" ? "custom" : source, // registry only has builtin/custom
          definitionHash: hashToolDef(def.id, def.description, def.jsonSchema ?? null),
          workspaceMutation: custom ? "possible" : toolWorkspaceMutation(def.id),
          permissionKeys: custom ? [def.id] : [],
          hostEnforced: true,
          evidence: custom ? `custom:${def.id}:host_permission` : `builtin:${def.id}`,
        } satisfies ToolCapability
      })

      // --- MCP tools ---
      const mcpRecord = yield* mcp.tools()
      const mcpTools: ToolCapability[] = Object.entries(mcpRecord).map(([key, mcpTool]) => {
        // Read derivedTier from the cached tool's riskTier if available.
        // We do NOT reconnect to the server to re-derive it.
        const riskTier = (mcpTool as Record<string, unknown>).riskTier as string | undefined
        const workspaceMutation: "never" | "possible" =
          riskTier === "read_only" || riskTier === "external_fetch" ? "never" : "possible"
        const hostEnforced = riskTier === "read_only"
        return {
          toolID: key,
          source: "mcp" as const,
          definitionHash: hashToolDef(
            key,
            (mcpTool as Record<string, unknown>).description as string ?? "",
            (mcpTool as Record<string, unknown>).inputSchema ?? null,
          ),
          workspaceMutation,
          permissionKeys: [],
          hostEnforced,
          evidence: `mcp:${key}:${riskTier ?? "unknown"}`,
        } satisfies ToolCapability
      })

      // --- Collision detection ---
      const allTools: ToolCapability[] = [...registryTools, ...mcpTools]
      const seenIDs = new Map<string, string[]>()
      for (const t of allTools) {
        const existing = seenIDs.get(t.toolID) ?? []
        existing.push(t.evidence)
        seenIDs.set(t.toolID, existing)
      }
      for (const [id, sources] of seenIDs) {
        if (sources.length > 1) {
          return yield* Effect.fail(new ToolIDCollisionError({ toolID: id, sources }))
        }
      }

      // --- Apply enablement overrides ---
      const overrides = input.toolOverrides ?? {}
      const enabledToolIDs = allTools
        .filter((t) => overrides[t.toolID] !== false)
        .map((t) => t.toolID)
        .sort()

      // --- Plugin interceptors ---
      const hooks = yield* plugin.list()
      const interceptors: RuntimeInterceptorCapability[] = []
      let pluginIdx = 0
      for (const hookSet of hooks) {
        const pluginID = `plugin:${pluginIdx++}` // stable within this snapshot
        const hookKeys = Object.keys(hookSet) as Array<keyof Hooks>
        for (const hook of hookKeys) {
          if (LIFECYCLE_HOOKS.has(hook as string)) {
            interceptors.push({
              pluginID,
              hook,
              phase: "lifecycle",
              taskReachable: false,
              workspaceBinding: "not_applicable",
              workspaceMutation: "never",
              hostEnforced: true,
              evidence: `${pluginID}:${hook}:lifecycle`,
            })
          } else {
            const profile = HOOK_PROFILE[hook] ?? UNKNOWN_HOOK_PROFILE
            interceptors.push({
              pluginID,
              hook,
              ...profile,
              evidence: `${pluginID}:${hook}`,
            })
          }
        }
      }

      // Sort interceptors for stable ordering
      const sortedInterceptors = [...interceptors].sort(
        (a, b) => a.pluginID.localeCompare(b.pluginID) || (a.hook as string).localeCompare(b.hook as string),
      )

      // --- Aggregate hash ---
      const hashInput = JSON.stringify({
        tools: allTools
          .map((tool) => ({
            id: tool.toolID,
            source: tool.source,
            hash: tool.definitionHash,
            mutation: tool.workspaceMutation,
            permissionKeys: tool.permissionKeys,
            hostEnforced: tool.hostEnforced,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        interceptors: sortedInterceptors.map((i) => ({ plugin: i.pluginID, hook: i.hook, mutation: i.workspaceMutation })),
        enabledToolIDs,
      })

      return {
        tools: allTools,
        interceptors: sortedInterceptors,
        enabledToolIDs,
        hash: Hash.sha256(hashInput),
      } satisfies ToolCapabilitySnapshot
    })
  },
} as const
