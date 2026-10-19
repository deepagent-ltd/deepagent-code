import { WorkspaceV2 } from "@deepagent-code/core/workspace"
import { Context, Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { Command } from "@/command"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { assertSafeInstanceRoot } from "@/project/instance-context"
import { MCP } from "."
import { McpAuthScope } from "./auth-scope"
import { McpAuthJournalSchema } from "./auth-journal-schema"

export type Input = Readonly<{ directory: string; workspaceID?: WorkspaceV2.ID }>
export interface Interface {
  readonly status: (input: Input) => Effect.Effect<Record<string, MCP.Status>>
  readonly resources: (input: Input) => Effect.Effect<Record<string, MCP.Resource>>
  readonly commands: (input: Input) => Effect.Effect<Command.ReadInfo[]>
}
export class Service extends Context.Service<Service, Interface>()("@deepagent-code/McpReadModel") {}

// This layer only captures the existing Root services. It never loads an instance
// or acquires another business-database owner, including on a missing directory.
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const instances = yield* InstanceStore.Service
    const projects = yield* Project.Service
    const configuration = yield* Config.Service
    const authentication = yield* McpAuthScope.Service
    const mcp = yield* MCP.Service
    const command = yield* Command.Service
    const observe = Effect.fn("McpReadModel.observe")(function* (input: Input) {
      // InstanceStore currently owns implicit-local directory instances only. A
      // shared project ID cannot authorize reuse in an explicit workspace.
      if (input.workspaceID) return yield* Effect.die(new Error("MCP readonly workspace placement unavailable"))
      yield* Effect.sync(() => assertSafeInstanceRoot(input.directory))
      const actual = yield* projects.observeDirectory(input.directory)
      const candidate = yield* instances.peek(input.directory)
      const observed = candidate?.project.id === actual.project?.id ? candidate : undefined
      if (!configuration.readonlySnapshot)
        return yield* Effect.die(new Error("Readonly configuration observation unavailable"))
      return { actual, observed, snapshot: configuration.readonlySnapshot({ ...actual, observed }) }
    })
    const status = Effect.fn("McpReadModel.status")(function* (input: Input) {
      const view = yield* observe(input)
      if (view.observed)
        return yield* mcp
          .status()
          .pipe(
            Effect.provideService(InstanceRef, view.observed),
            Effect.provideService(WorkspaceRef, input.workspaceID),
          )
      const snapshot = yield* view.snapshot
      const result: Record<string, MCP.Status> = {}
      for (const [name, config] of Object.entries(snapshot.config.mcp ?? {})) {
        if (!config || typeof config !== "object" || !("type" in config)) continue
        if (config.enabled === false) {
          result[name] = { status: "disabled" }
          continue
        }
        const observed =
          config.type === "remote" && config.oauth !== false
            ? yield* authentication
                .metadataAt(name, config, {
                  directory: view.actual.directory,
                  projectID: view.actual.project?.id,
                  projectVcs: view.actual.project?.vcs,
                  workspaceID: input.workspaceID,
                  snapshot,
                })
                .pipe(Effect.result)
            : undefined
        if (observed?._tag === "Failure") {
          result[name] = { status: "failed", error: observed.failure instanceof McpAuthJournalSchema.Error &&
            observed.failure.reason === "legacy_unverified" ? observed.failure.message : "MCP authentication storage or scope is unavailable" }
          continue
        }
        const metadata = observed?.success
        result[name] = {
          status: "disconnected",
          authStatus: metadata?.unknown
            ? "unknown"
            : metadata?.tokens
              ? metadata.expired
                ? "expired"
                : "authenticated"
              : metadata?.legacy
                ? "legacy_unverified"
                : "not_authenticated",
          reason: metadata?.unknown ? "unknown_outcome" : "explicit_connect_required",
        }
      }
      return result
    })
    const resources = Effect.fn("McpReadModel.resources")(function* (input: Input) {
      const view = yield* observe(input)
      if (!view.observed) return {}
      if (!mcp.observedMetadata) return yield* Effect.die(new Error("Readonly MCP metadata unavailable"))
      return (yield* mcp.observedMetadata!().pipe(
        Effect.provideService(InstanceRef, view.observed),
        Effect.provideService(WorkspaceRef, input.workspaceID),
      )).resources
    })
    const commands = Effect.fn("McpReadModel.commands")(function* (input: Input) {
      const view = yield* observe(input)
      const snapshot = yield* view.snapshot
      if (view.observed && !mcp.observedMetadata)
        return yield* Effect.die(new Error("Readonly MCP metadata unavailable"))
      const prompts = view.observed
        ? (yield* mcp.observedMetadata!().pipe(
            Effect.provideService(InstanceRef, view.observed),
            Effect.provideService(WorkspaceRef, input.workspaceID),
          )).prompts
        : {}
      return yield* command.readonlyList(snapshot, prompts, view.observed)
    })
    return Service.of({ status, resources, commands })
  }),
).pipe(Layer.provide(McpAuthScope.defaultLayer))

export * as McpReadModel from "./read-model"
