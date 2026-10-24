import { tmpdir } from "../fixture/fixture"
import { V2RunnerFrame } from "@/session/v2-runner-frame"
import {
  LocationRuntimeHost,
  defaultLocationRuntimeHost,
  locationServiceMapDependencies,
} from "@deepagent-code/core/location-layer"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { expect, test } from "bun:test"
import path from "node:path"
import { Context, Effect, Exit, Layer } from "effect"
import { AgentGateway, DeepAgentKnowledgeSource } from "@deepagent-code/core/agent-gateway"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { ProductionV2Sources } from "@deepagent-code/core/context-federation/production-adapters"
import { projectIdForWorkspace } from "@deepagent-code/core/deepagent/durable-knowledge-store"
import { ProductionSources } from "../../src/context-federation/production-sources"
import { LocationIndexRuntime } from "../../src/location-index/runtime"
import { InstanceStore } from "../../src/project/instance-store"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceRef } from "../../src/effect/instance-ref"

const bootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const instanceLayer = InstanceStore.defaultLayer.pipe(Layer.provide(bootstrap))

// Actual immutable Gateway / InstanceState / index / fileDB; no model, Native or full-root qualification.
test("scoped Gateway stores replace the early empty seam and stay isolated from another root and legacy default", async () => {
  await using fixture = await tmpdir()
  const root = path.join(fixture.path, "two-roots")
  const workspaces = [path.join(root, "a"), path.join(root, "b")]
  await Promise.all(workspaces.map((workspace) => Bun.write(path.join(workspace, "README.md"), "# Scoped stores\n")))
  DeepAgentKnowledgeSource.reset()
  await Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* Layer.build(
        Layer.mergeAll(
          ProductionSources.productionSourcesLayer({ workspaceDirectory: path.join(root, "wrong-cwd") }),
          LocationIndexRuntime.defaultLayer,
          instanceLayer,
        ),
      )
      const base = Context.get(context, ProductionV2Sources)
      expect(base.knowledge?.stores).toHaveLength(0)
      DeepAgentKnowledgeSource.configure(path.join(root, "legacy-decoy"))
      const frames = yield* Effect.forEach(workspaces, (workspace, i) =>
        Effect.gen(function* () {
          const gatewayContext = yield* Layer.build(
            AgentGateway.runtimeLayer({
              enabled: true,
              agentMode: "general",
              durableLearning: false,
              baseDir: path.join(root, `gateway-${i}`),
            }),
          )
          const gateway = Context.get(gatewayContext, AgentGateway.Runtime)
          const seeded = gateway.withStorage(() =>
            DeepAgentKnowledgeSource.storesForWorkspace(workspace)[1]!.seedActive({
              type: "memory",
              scope: "project-shared",
              projectId: projectIdForWorkspace(workspace),
              description: `private root ${i}`,
              body: `FRAME-ROOT-${i}`,
              domain: null,
              tags: [],
              sensitivity: "public",
              risk: "low",
              confidence: { evidence_strength: "strong", support_count: 1 },
              provenance: { source: "runner", evidence_refs: [] },
            }),
          )
          const framedContext = yield* Layer.build(
            V2RunnerFrame.runnerFrameSeamFor({ directory: AbsolutePath.make(workspace) }, base).pipe(
              Layer.provide(Layer.succeedContext(context)),
              Layer.provide(Layer.succeed(AgentGateway.Runtime, gateway)),
            ),
          )
          const framed = Context.get(framedContext, ProductionV2Sources)
          expect(framed.knowledge?.stores).toHaveLength(2)
          expect(framed.knowledge?.stores[1]?.documentStore.get(seeded.id)?.body).toBe(`FRAME-ROOT-${i}`)
          return framed
        }),
      )
      expect(frames[0]?.knowledge?.stores[0]).not.toBe(frames[1]?.knowledge?.stores[0])
      expect(frames[0]?.knowledge?.stores[1]).not.toBe(frames[1]?.knowledge?.stores[1])
      expect(DeepAgentKnowledgeSource.storesForWorkspace(workspaces[0])[1]!.documentStore.list()).toHaveLength(0)
      yield* Context.get(context, InstanceStore.Service).disposeAll()
    }).pipe(Effect.scoped),
  )
  DeepAgentKnowledgeSource.reset()
}, 30_000)

test("automatic document reads retain the real InstanceRef and reject a retired captured instance", async () => {
  await using fixture = await tmpdir()
  const workspace = path.join(fixture.path, "current-frame")
  await Bun.write(path.join(workspace, "README.md"), "# CONTEXTFRAMEAUDIT\nReal session context evidence.\n")
  await Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* Layer.build(
        Layer.mergeAll(
          ProductionSources.productionSourcesLayer({ workspaceDirectory: workspace }),
          LocationIndexRuntime.defaultLayer,
          instanceLayer,
          AgentGateway.runtimeLayer({
            enabled: true,
            agentMode: "general",
            durableLearning: false,
            baseDir: path.join(workspace, "gateway"),
          }),
        ),
      )
      const instances = Context.get(context, InstanceStore.Service)
      const runtime = Context.get(context, LocationIndexRuntime.Service)
      const ctx = yield* instances.load({ directory: workspace })
      const handle = yield* runtime.current().pipe(Effect.provideService(InstanceRef, ctx))
      expect(handle).toBeDefined()
      // The production watcher owns initialization; wait without invoking a competing rebuild.
      yield* Effect.promise(async () => {
        for (let attempt = 0; attempt < 100; attempt++) {
          const ready = await Effect.runPromiseExit(
            handle!.coordinator.searchDocuments({ query: "CONTEXTFRAMEAUDIT", limit: 5 }),
          )
          if (Exit.isSuccess(ready) && ready.value.hits.some((hit) => hit.document.path === "README.md")) return
          await Bun.sleep(25)
        }
        throw new Error("production document index did not become ready")
      })
      const built = yield* Layer.build(
        V2RunnerFrame.runnerFrameSeamFor(
          { directory: AbsolutePath.make(workspace) },
          Context.get(context, ProductionV2Sources),
        ).pipe(Layer.provide(Layer.succeedContext(context))),
      )
      const framed = Context.get(built, ProductionV2Sources)
      const documents = yield* framed.documents!.search({ query: "CONTEXTFRAMEAUDIT", limit: 5 })
      expect(documents.hits.some((hit) => hit.document.path === "README.md")).toBe(true)
      expect(yield* framed.documents!.mutationEpoch!()).toBeNumber()
      yield* instances.dispose(ctx)
      const retired = yield* framed.documents!.search({ query: "CONTEXTFRAMEAUDIT", limit: 5 }).pipe(Effect.exit)
      expect(Exit.isFailure(retired)).toBe(true)
      expect(yield* instances.peek(workspace)).toBeUndefined()
      yield* instances.disposeAll()
    }).pipe(Effect.scoped),
  )
}, 30_000)

test("an unconfigured per-ref gateway never adopts legacy global knowledge stores", async () => {
  await using fixture = await tmpdir()
  const workspace = path.join(fixture.path, "unconfigured-frame")
  await Bun.write(path.join(workspace, "README.md"), "# Unconfigured frame\n")
  DeepAgentKnowledgeSource.configure(path.join(workspace, "legacy-decoy"))
  await Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* Layer.build(
        Layer.mergeAll(
          ProductionSources.productionSourcesLayer({ workspaceDirectory: workspace }),
          LocationIndexRuntime.defaultLayer,
          instanceLayer,
        ),
      )
      expect(Context.get(context, ProductionV2Sources).knowledge?.stores).toHaveLength(2)
      const framed = yield* Layer.build(
        V2RunnerFrame.runnerFrameSeamFor(
          { directory: AbsolutePath.make(workspace) },
          Context.get(context, ProductionV2Sources),
        ).pipe(Layer.provide(Layer.succeedContext(context))),
      )
      expect(Context.get(framed, ProductionV2Sources).knowledge).toBeUndefined()
      yield* Context.get(context, InstanceStore.Service).disposeAll()
    }).pipe(Effect.scoped),
  )
  DeepAgentKnowledgeSource.reset()
}, 30_000)

test("the normal location dependency factory gives its exact Gateway argument to the host", async () => {
  await using fixture = await tmpdir()
  const root = path.join(fixture.path, "composition")
  await Effect.runPromise(
    Effect.gen(function* () {
      const memo = yield* Layer.makeMemoMap
      const scope = yield* Effect.scope
      const frames = yield* Effect.forEach(["a", "b"], (name) =>
        Effect.gen(function* () {
          const host = Layer.effect(
            LocationRuntimeHost,
            Effect.gen(function* () {
              const fallback = yield* LocationRuntimeHost
              const gateway = yield* AgentGateway.Runtime
              return LocationRuntimeHost.of({
                layer: (ref) =>
                  Layer.mergeAll(
                    fallback.layer(ref),
                    Layer.succeed(ProductionV2Sources, {
                      knowledge: {
                        stores: gateway.withStorage(() => DeepAgentKnowledgeSource.storesForWorkspace(ref.directory)),
                      },
                    }),
                  ),
              })
            }),
          ).pipe(Layer.provide(defaultLocationRuntimeHost))
          const gateway = AgentGateway.runtimeLayer({
            enabled: true,
            agentMode: "general",
            durableLearning: false,
            baseDir: path.join(root, name),
          })
          const dependencies = locationServiceMapDependencies(
            host,
            Database.defaultLayer,
            EventV2.defaultLayer,
            gateway,
          )
          const built = yield* Layer.buildWithMemoMap(
            Layer.mergeAll(...dependencies).pipe(
              Layer.provide(
                AgentGateway.runtimeLayer({
                  enabled: true,
                  agentMode: "general",
                  durableLearning: false,
                  baseDir: path.join(root, "wrong-outer"),
                }),
              ),
            ),
            memo,
            scope,
          )
          const framed = yield* Layer.build(
            Context.get(built, LocationRuntimeHost)
              .layer({ directory: AbsolutePath.make(root) })
              .pipe(Layer.provide(Layer.succeedContext(built))),
          )
          const stores = Context.get(framed, ProductionV2Sources).knowledge!.stores
          const same = Context.get(built, AgentGateway.Runtime).withStorage(() =>
            DeepAgentKnowledgeSource.storesForWorkspace(root),
          )
          expect(stores[0] === same[0]).toBe(true)
          expect(stores[1] === same[1]).toBe(true)
          return stores
        }),
      )
      expect(frames[0]?.[0]).not.toBe(frames[1]?.[0])
      expect(frames[0]?.[1]).not.toBe(frames[1]?.[1])
    }).pipe(Effect.scoped),
  )
}, 30_000)
