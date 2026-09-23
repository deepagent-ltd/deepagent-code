export * as ToolRegistry from "./registry"

import {
  ToolOutput,
  type ToolCall,
  type ToolDefinition,
  type ToolSettlement,
  type ToolContent,
  type ToolFileContent,
} from "@deepagent-code/llm"
import { Context, Effect, Layer, Scope } from "effect"
import { AgentV2 } from "../agent"
import { Location } from "../location"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { ToolOutputStore } from "../tool-output-store"
import { ApplicationTools } from "./application-tools"
import { definition, permission, RegistrationError, settle, validateName, type AnyTool } from "./tool"
import { Tools } from "./tools"

export type ExecuteInput = {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly call: ToolCall
  readonly location?: Location.Ref
}

export interface Interface {
  readonly materialize: (permissions?: PermissionV2.Ruleset | PermissionPolicy) => Effect.Effect<Materialization>
  /** Internal registration capability exposed publicly only through Tools.Service. */
  readonly register: (tools: Readonly<Record<string, AnyTool>>) => Effect.Effect<void, RegistrationError, Scope.Scope>
}

export type PermissionPolicy = { readonly rulesets: readonly PermissionV2.Ruleset[] }

export interface Materialization {
  readonly registeredIDs: ReadonlyArray<string>
  readonly permissionFilteredIDs: ReadonlyArray<string>
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly effectKind: (name: string) => "mutating" | "read_only"
  readonly settle: (input: ExecuteInput) => Effect.Effect<Settlement, ToolOutputStore.Error>
  readonly rehydrateArtifact: (input: {
    readonly sessionID: SessionSchema.ID
    readonly file: ToolFileContent
    readonly location?: Location.Ref
  }) => Effect.Effect<ToolContent, ToolOutputStore.Error>
}

export interface Settlement extends ToolSettlement {
  readonly outputPaths?: ReadonlyArray<string>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/v2/ToolRegistry") {}

export const MAX_LOCATION_TOOL_NAMES = 256
export const MAX_TOOL_OVERLAYS_PER_NAME = 32
export const MAX_MATERIALIZED_TOOL_NAMES = MAX_LOCATION_TOOL_NAMES * 2

const registryLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const resources = yield* ToolOutputStore.Service
    type Registration = { readonly identity: object; readonly tool: AnyTool }
    const local = new Map<string, Array<{ readonly token: object; readonly registration: Registration }>>()

    const settleWith = Effect.fn("ToolRegistry.settle")(function* (input: ExecuteInput, advertised?: object) {
      const registration =
        local.get(input.call.name)?.at(-1)?.registration ?? applications.entries().get(input.call.name)
      if (!registration)
        return {
          result: {
            type: "error" as const,
            value: advertised ? `Stale tool call: ${input.call.name}` : `Unknown tool: ${input.call.name}`,
          },
        }
      if (advertised && registration.identity !== advertised)
        return { result: { type: "error" as const, value: `Stale tool call: ${input.call.name}` } }
      const pending = yield* settle(registration.tool, input.call, {
        sessionID: input.sessionID,
        agent: input.agent,
        assistantMessageID: input.assistantMessageID,
        toolCallID: input.call.id,
      }).pipe(
        Effect.map((output) => ({ output })),
        Effect.catchTag("LLM.ToolFailure", (failure) =>
          Effect.succeed({
            result: {
              type: "error" as const,
              value: failure.message,
              ...(failure.metadata === undefined ? {} : { metadata: failure.metadata }),
            },
          }),
        ),
      )
      if ("result" in pending) return pending
      const output = pending.output
      const bounded = yield* resources
        .bound({ sessionID: input.sessionID, toolCallID: input.call.id, output, location: input.location })
        .pipe(
          Effect.map((value) => ({ _tag: "bounded" as const, value })),
          Effect.catchTag("ToolArtifact.Error", (error) => Effect.succeed({ _tag: "artifact_error" as const, error })),
        )
      if (bounded._tag === "artifact_error")
        return {
          result: {
            type: "error" as const,
            value: `Tool artifact unavailable: ${bounded.error.reason}`,
            metadata: { reason: bounded.error.reason },
          },
        }
      const retained = bounded.value
      // The durable tool event keeps an opaque artifact ref. The next provider turn reloads
      // that ref from the Session's artifact store; it does not persist inline base64 twice.
      const result = retained.output.content.some(
        (item) => item.type === "file" && item.source.type === "file" && item.source.uri.startsWith("artifact:"),
      )
        ? { type: "text" as const, value: "Tool artifact retained for provider replay" }
        : ToolOutput.toResultValue(retained.output)
      if (result.type === "error")
        return retained.outputPaths.length > 0 ? { result, outputPaths: retained.outputPaths } : { result }
      return retained.outputPaths.length > 0
        ? { result, output: retained.output, outputPaths: retained.outputPaths }
        : { result, output: retained.output }
    })

    return Service.of({
      register: Effect.fn("ToolRegistry.register")(function* (tools) {
        const entries = Object.entries(tools)
        if (entries.length === 0) return
        yield* Effect.forEach(entries, ([name]) => validateName(name), { discard: true })
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const token = {}
            const newNames = entries.filter(([name]) => !local.has(name)).length
            if (local.size + newNames > MAX_LOCATION_TOOL_NAMES)
              return yield* new RegistrationError({
                name: entries.find(([name]) => !local.has(name))?.[0] ?? "registry",
                message: `Too many Location tool names (limit ${MAX_LOCATION_TOOL_NAMES})`,
              })
            const full = entries.find(([name]) => (local.get(name)?.length ?? 0) >= MAX_TOOL_OVERLAYS_PER_NAME)
            if (full)
              return yield* new RegistrationError({
                name: full[0],
                message: `Too many registrations for tool ${full[0]} (limit ${MAX_TOOL_OVERLAYS_PER_NAME})`,
              })
            for (const [name, tool] of entries)
              local.set(name, [...(local.get(name) ?? []), { token, registration: { identity: {}, tool } }])
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                for (const [name] of entries) {
                  const registrations = local.get(name)?.filter((registration) => registration.token !== token) ?? []
                  if (registrations.length > 0) local.set(name, registrations)
                  else local.delete(name)
                }
              }),
            )
          }),
        )
      }),
      materialize: Effect.fn("ToolRegistry.materialize")(function* (permissions = []) {
        const registrations = new Map(applications.entries())
        for (const [name, entries] of local) {
          const registration = entries.at(-1)?.registration
          if (registration) registrations.set(name, registration)
        }
        if (registrations.size > MAX_MATERIALIZED_TOOL_NAMES)
          return yield* Effect.die(
            `Tool registry exceeded materialization limit ${MAX_MATERIALIZED_TOOL_NAMES}; registration bounds were bypassed`,
          )
        const registeredIDs = [...registrations.keys()]
        for (const [name, registration] of registrations)
          if (whollyDisabled(permission(registration.tool, name), permissions)) registrations.delete(name)
        return {
          registeredIDs,
          permissionFilteredIDs: [...registrations.keys()],
          definitions: Array.from(registrations, ([name, registration]) => definition(name, registration.tool)),
          // Read-only classification is an explicit allowlist. Unknown/custom actions remain
          // mutating so durable side-effect evidence never undercounts a newly registered tool.
          effectKind: (name) => {
            const registration = registrations.get(name)
            if (!registration) return "mutating"
            return readOnlyActions.has(permission(registration.tool, name)) ? "read_only" : "mutating"
          },
          settle: (input) => {
            const registration = registrations.get(input.call.name)
            if (registration) return settleWith(input, registration.identity)
            return Effect.succeed({ result: { type: "error", value: `Unknown tool: ${input.call.name}` } })
          },
          rehydrateArtifact: resources.rehydrate,
        }
      }),
    })
  }),
)

export const layer = Layer.effect(
  Tools.Service,
  Service.use((registry) => Effect.succeed(Tools.Service.of({ register: registry.register }))),
).pipe(Layer.provideMerge(registryLayer))

const readOnlyActions = new Set([
  "read",
  "glob",
  "grep",
  "git_read",
  "webfetch",
  "websearch",
  "skill",
  "code_intel",
  "context_query",
  "capability_search",
  "capability.read",
  "task_status",
  "task_read",
])

function whollyDisabled(action: string, policy: PermissionV2.Ruleset | PermissionPolicy) {
  const rulesets = "rulesets" in policy ? policy.rulesets : [policy]
  return PermissionV2.isActionWhollyDenied(action, ...rulesets)
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [ApplicationTools.node, ToolOutputStore.node],
})

export const toolsNode = makeLocationNode({
  service: Tools.Service,
  layer,
  deps: [ApplicationTools.node, ToolOutputStore.node],
})

export const defaultLayer = layer.pipe(
  Layer.provide(ApplicationTools.layer),
  Layer.provide(ToolOutputStore.defaultLayer),
)
