import { expect, test } from "bun:test"
import path from "node:path"
import { Context, Effect, Exit, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { AgentGateway, DeepAgentKnowledgeSource } from "@deepagent-code/core/agent-gateway"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { Database } from "@deepagent-code/core/database/database"
import { ProductionV2Sources } from "@deepagent-code/core/context-federation/production-adapters"
import { ProductionSources } from "@/context-federation/production-sources"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { BackgroundJob } from "@/background/job"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { LocationIndexRuntime } from "@/location-index/runtime"
import { InstanceRef } from "@/effect/instance-ref"
import { Session } from "@/session/session"
import { ContextApi } from "@/server/routes/instance/httpapi/groups/context"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { instanceContextLayer } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { schemaErrorLayer } from "@/server/routes/instance/httpapi/middleware/schema-error"

import { contextHandlers } from "@/server/routes/instance/httpapi/handlers/context"
import { tmpdir } from "../fixture/fixture"

test("actual readiness uses the scoped runner sources and refuses a foreign Session before loading its root", async () => {
  await using fixture = await tmpdir()
  const root = path.join(fixture.path, "readiness-route")
  const directory = path.join(root, "current")
  const foreign = path.join(root, "foreign")
  await Bun.write(path.join(directory, "README.md"), "# session context\nCURRENTREADINESSFACT\n")
  await Bun.write(
    path.join(directory, "main.ts"),
    "export function sessionContext() { return 'CURRENTREADINESSFACT' }\n",
  )
  await Bun.write(path.join(foreign, "README.md"), "# Never exposed\nFOREIGNREADINESSFACT\n")
  DeepAgentKnowledgeSource.reset()
  await Effect.runPromise(
    Effect.gen(function* () {
      const common = Layer.mergeAll(
        Database.defaultLayer,
        RuntimeFlags.defaultLayer,
        EventV2Bridge.defaultLayer,
        Layer.mock(BackgroundJob.Service)({}),
      )
      const services = Layer.mergeAll(
        common,
        Session.layer.pipe(Layer.provide(common)),
        ProductionSources.productionSourcesLayer({ workspaceDirectory: path.join(root, "wrong-cwd") }),
        LocationIndexRuntime.defaultLayer,
        InstanceStore.defaultLayer.pipe(
          Layer.provide(Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))),
        ),
        AgentGateway.runtimeLayer({
          enabled: true,
          agentMode: "general",
          durableLearning: false,
          baseDir: path.join(root, "gateway"),
        }),
      )
      const built = yield* Layer.build(services)
      const db = Context.get(built, Database.Service).db
      const currentID = SessionSchema.ID.create()
      const foreignID = SessionSchema.ID.create()
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values([
          {
            id: currentID,
            project_id: Project.ID.global,
            directory,
            title: "current readiness",
            slug: "current",
            version: "test",
          },
          {
            id: foreignID,
            project_id: Project.ID.global,
            directory: foreign,
            title: "foreign readiness",
            slug: "foreign",
            version: "test",
          },
        ])
        .run()
        .pipe(Effect.orDie)
      expect(Context.get(built, ProductionV2Sources).knowledge?.stores).toHaveLength(0)
      const instances = Context.get(built, InstanceStore.Service)
      const instance = yield* instances.load({ directory })
      const handle = yield* Context.get(built, LocationIndexRuntime.Service)
        .current()
        .pipe(Effect.provideService(InstanceRef, instance))
      if (!handle) return yield* Effect.die("real readiness index missing")
      yield* Effect.promise(async () => {
        for (let attempt = 0; attempt < 100; attempt++) {
          const ready = await Effect.runPromiseExit(
            handle.coordinator.searchDocuments({ query: "CURRENTREADINESSFACT", limit: 5 }),
          )
          if (Exit.isSuccess(ready) && ready.value.hits.length > 0) return
          await Bun.sleep(25)
        }
        throw new Error("readiness document index did not become ready")
      })
      const middleware = Layer.mergeAll(
        schemaErrorLayer,
        instanceContextLayer,
        Layer.succeed(
          Authorization,
          Authorization.of((effect) => effect),
        ),
        Layer.succeed(
          WorkspaceRoutingMiddleware,
          WorkspaceRoutingMiddleware.of((effect) =>
            effect.pipe(Effect.provideService(WorkspaceRouteContext, { directory })),
          ),
        ),
      ).pipe(Layer.provide(Layer.succeedContext(built)))
      const web = HttpRouter.toWebHandler(
        HttpApiBuilder.layer(HttpApi.make("deepagent-code-instance").addHttpApi(ContextApi)).pipe(
          Layer.provide(contextHandlers),
          Layer.provide(middleware),
          Layer.provide(Layer.succeedContext(built)),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true },
      )
      yield* Effect.addFinalizer(() => Effect.promise(web.dispose))
      const current = yield* Effect.promise(() =>
        web.handler(new Request(`http://localhost/context/readiness?session_id=${currentID}`), built),
      )
      expect(current.status).toBe(200)
      const result = yield* Effect.promise(() => current.json())
      expect(result.session_id).toBe(currentID)
      expect(result.statuses.code.status).toBe("ready")
      expect(result.statuses.documents.status).toBe("ready")
      expect(result.statuses.knowledge.revision).toBe("released:none")
      expect(result.statuses.memory.revision).toBe("memory:0")
      const rejected = yield* Effect.promise(() =>
        web.handler(new Request(`http://localhost/context/readiness?session_id=${foreignID}`), built),
      )
      expect(rejected.status).toBe(404)
      expect(JSON.stringify(yield* Effect.promise(() => rejected.json()))).not.toContain("FOREIGNREADINESSFACT")
      expect(yield* instances.peek(foreign)).toBeUndefined()
      expect(yield* instances.peek(directory)).toBe(instance)
      yield* instances.disposeAll()
    }).pipe(Effect.scoped),
  )
}, 30_000)
