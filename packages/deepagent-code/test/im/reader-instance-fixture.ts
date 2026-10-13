export * as ReaderInstanceFixture from "./reader-instance-fixture"

import { Effect, Layer } from "effect"
import { ProjectV2 } from "@deepagent-code/core/project"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { InstanceRegistry } from "@/effect/instance-registry"
import { Project } from "@/project/project"

// The actual Store creates and owns each context. Only project discovery is
// replaced; no Location, model, tool or provider graph is constructed here.
export const project = (directory: string): Project.Info => ({ id: ProjectV2.ID.make("im-reader-fixture"), worktree: directory, time: { created: 0, updated: 0 }, sandboxes: [] })
export const registry = InstanceRegistry.layer
export const layer = InstanceStore.layer.pipe(
  Layer.provide(registry),
  Layer.provide(Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })),
  Layer.provide(Layer.mock(Project.Service, { fromDirectory: (directory) => Effect.succeed({ project: project(directory), sandbox: directory }) })),
)
