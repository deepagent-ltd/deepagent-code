export * as LocationIndexRuntime from "./runtime"

import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LocationIdentity, type Identity } from "@deepagent-code/core/context-federation/identity"
import { LocationIndexCoordination } from "@deepagent-code/core/context-federation/coordination"
import { Database } from "@deepagent-code/core/database/database"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Global } from "@deepagent-code/core/global"
import { LocationChangeJournal } from "@deepagent-code/core/location-index/change-journal"
import { LocationCommitLock } from "@deepagent-code/core/location-index/commit-lock"
import { projectIdForWorkspace } from "@deepagent-code/core/deepagent/durable-knowledge-store"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { Context, Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { LocationIndexCoordinator } from "./coordinator"
import { start } from "./watcher-consumer"

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly current: () => Effect.Effect<{
    readonly identity: Identity
    readonly coordinator: LocationIndexCoordinator.Interface
  } | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/LocationIndexRuntime") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    const identities = yield* LocationIdentity.Service
    const coordination = yield* LocationIndexCoordination.Service
    const journal = yield* LocationChangeJournal.Service
    const lock = yield* LocationCommitLock.Service
    const events = yield* EventV2Bridge.Service
    const ownerId = `${process.pid}:${randomUUID()}`
    const state = yield* InstanceState.make(
      Effect.fn("LocationIndexRuntime.instance")(function* (instance) {
        if (!flags.locationIndexesV2Shadow) return undefined
        // Non-git instances resolve to the "global" sentinel project id, which is NOT a valid
        // observed project for durable authorities: the released-knowledge scope guard pins
        // context_project_scope_identity.observed_project_id to the canonical durable knowledge
        // project id. Record that canonical id here so whichever resolver arrives first writes it.
        const identity = yield* identities.resolve({
          boundary: { kind: "implicit_local" },
          directory: AbsolutePath.make(instance.directory),
          project: instance.project.vcs === "git"
            ? { kind: "git", observedProjectId: instance.project.id }
            : { kind: "registered_root", observedProjectId: projectIdForWorkspace(instance.directory) },
        })
        const built = yield* Layer.build(
          LocationIndexCoordinator.layer({
            identity,
            ownerId,
            indexDirectory: path.join(Global.Path.cache, "context-indexes"),
          }).pipe(
            Layer.provide(Layer.succeed(LocationIndexCoordination.Service, coordination)),
            Layer.provide(Layer.succeed(LocationChangeJournal.Service, journal)),
            Layer.provide(Layer.succeed(LocationCommitLock.Service, lock)),
          ),
        )
        const coordinator = Context.get(built, LocationIndexCoordinator.Service)
        yield* start({ coordinator, events, instance }).pipe(
          Effect.catchCause((cause) => Effect.logWarning("Location index runtime stopped", { cause })),
          Effect.forkScoped,
        )
        return { identity, coordinator }
      }),
    )
    return Service.of({
      init: () => InstanceState.get(state).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Location index runtime unavailable", { cause })),
        Effect.asVoid,
      ),
      current: () => InstanceState.get(state).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Location index runtime unavailable", { cause }).pipe(Effect.as(undefined)),
        ),
      ),
    })
  }),
)

const database = Database.defaultLayer
const dependencies = Layer.mergeAll(
  RuntimeFlags.defaultLayer,
  EventV2Bridge.defaultLayer,
  LocationIdentity.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer)),
  LocationIndexCoordination.layer.pipe(Layer.provide(database)),
  LocationChangeJournal.layer.pipe(Layer.provide(database)),
  LocationCommitLock.layer({
    directory: path.join(Global.Path.state, "context-index-coordination", "locks"),
    timeoutMs: 10_000,
    staleMs: 60_000,
    pollMs: 10,
  }),
)

export const defaultLayer: Layer.Layer<Service> = layer.pipe(Layer.provide(dependencies))
