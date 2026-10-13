import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Global } from "@deepagent-code/core/global"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { Config } from "@/config/config"
import { SecretRefScope } from "@/mcp/secret-ref-scope"
import { McpSecretMigration } from "@/mcp/secret-migration"
import { SecretStore } from "@/mcp/secret-store"
import { AccountRepo } from "@/account/repo"
import { Project } from "@/project/project"
import { Env } from "@/env"
import { AuthTest } from "../../fake/auth"
import { Account } from "@/account/account"
import { NpmTest } from "../../fake/npm"
import { parse } from "jsonc-parser"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { EventV2Bridge } from "@/event-v2-bridge"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { LocalAuthority } from "@/installation/local-authority"
import { Database } from "@deepagent-code/core/database/database"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { WorkAuthority } from "@deepagent-code/core/session/work-authority"
import { WorkExecutionTable, WorkDispatchReservationTable } from "@deepagent-code/core/session/work-authority.sql"
import { SessionTable, SessionInputTable } from "@deepagent-code/core/session/sql"
import { V2ProviderTurnReceiptTable } from "@deepagent-code/core/session/runner/v2-provider-turn.sql"
import { WorkCountAcquisitionTable } from "@deepagent-code/core/session/work-count-acquisition.sql"
import { WorkAuthorityFixture } from "../../../../core/test/fixture/work-authority"
import { eq, count } from "drizzle-orm"

const root = await fs.realpath(process.argv[2])
const mode = process.argv[3]
const a = path.join(root, "a", "project")
const b = path.join(root, "b", "project")
const physical = { http: 0 }
const listener =
  mode === "runtime"
    ? Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          physical.http++
          return new Response(null, { status: 500 })
        },
      })
    : undefined
await Promise.all([fs.mkdir(a, { recursive: true }), fs.mkdir(b, { recursive: true })])
const original = (value: string) =>
  `// keep this comment\n${JSON.stringify(
    {
      mcp: {
        same: {
          type: "remote",
          url: listener ? `http://127.0.0.1:${listener.port}/endpoint` : "https://mcp.example.invalid/endpoint",
          headers: { Authorization: value },
          oauth: {
            clientId: "fixture-client",
            expectedIssuer: "https://issuer.example.invalid",
            clientSecret: `${value}-client`,
          },
          enabled: false,
        },
        local: {
          type: "local",
          command: ["never-spawn-this"],
          environment: { GITHUB_PERSONAL_ACCESS_TOKEN: `${value}-env` },
          enabled: false,
        },
        sibling: { type: "local", command: ["retained"], enabled: false },
      },
    },
    null,
    2,
  )}`
if (mode !== "cold") {
  await Promise.all([
    fs.writeFile(path.join(a, "deepagent-code.json"), original("fixture-a")),
    fs.writeFile(path.join(b, "deepagent-code.json"), original("fixture-b")),
  ])
}
const counts = { put: 0, get: 0, network: 0 }
const actual = SecretStore.fileBackend()
const backend: SecretStore.Backend = {
  ...actual,
  put: async (account, value) => {
    counts.put++
    await actual.put(account, value)
    if (mode === "stored-gap" && counts.put === 2)
      await fs.writeFile(path.join(a, "deepagent-code.json"), original("external-edit"))
  },
  get: async (account) => {
    counts.get++
    return actual.get(account)
  },
}
const config = Config.layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(AuthTest.empty),
  Layer.provide(Account.defaultLayer),
  Layer.provide(NpmTest.noop),
  Layer.provide(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => {
        counts.network++
        return Effect.die("Unexpected network")
      }),
    ),
  ),
)
const common = Layer.mergeAll(
  config,
  Database.defaultLayer,
  AccountRepo.defaultLayer,
  LocationIdentity.defaultLayer,
  Project.defaultLayer,
  SecretStore.testLayer(backend),
  FSUtil.defaultLayer,
  EffectFlock.defaultLayer,
)
const scoped = SecretRefScope.layer.pipe(Layer.provideMerge(common))
const migrationLayer = McpSecretMigration.layer.pipe(Layer.provideMerge(scoped))
const runtimeLayer = MCP.layer.pipe(
  Layer.provideMerge(migrationLayer),
  Layer.provideMerge(McpAuth.defaultLayer),
  Layer.provideMerge(EventV2Bridge.defaultLayer),
  Layer.provideMerge(CrossSpawnSpawner.defaultLayer),
)
const instances = InstanceStore.defaultLayer.pipe(
  Layer.provide(
    Layer.succeed(
      InstanceBootstrap.Service,
      InstanceBootstrap.Service.of({ run: mode === "api" ? Effect.die("Unexpected instance bootstrap") : Effect.void }),
    ),
  ),
)
const layer = Layer.mergeAll(runtimeLayer, instances)
const result = await Effect.runPromiseExit(
  Effect.gen(function* () {
    const scopes = yield* SecretRefScope.Service
    const migration = yield* McpSecretMigration.Service
    const secrets = yield* SecretStore.Service
    const mcp = yield* MCP.Service
    const cfg = yield* Config.Service
    const instances = yield* InstanceStore.Service
    const identities = yield* LocationIdentity.Service
    const database = yield* Database.Service
    const inDirectory = <A, E>(effect: Effect.Effect<A, E>, directory: string) =>
      Effect.runPromise(effect.pipe(Effect.provideService(SecretRefScope.CliDirectory, directory)))
    const setup = (directory: string) => inDirectory(scopes.capture("same", true), directory)
    const migrate = async (name: string, directory: string, requestID: string) => {
      const preview = await inDirectory(migration.preview(name), directory)
      assert(!JSON.stringify(preview).includes("fixture-a-client"))
      return inDirectory(migration.commit({ previewID: preview.previewID, requestID }), directory)
    }
    return yield* Effect.tryPromise({
      try: async () => {
        if (mode === "cold") {
          const before = await awaitBytes()
          const status = await inDirectory(migration.status("first-a"), a)
          assert(status)
          assert.equal(status.state, "stored")
          const exit = await inDirectory(migration.reconcile("first-a").pipe(Effect.exit), a)
          assert(Exit.isFailure(exit))
          assert.equal(counts.put, 0)
          assert.deepEqual(await awaitBytes(), before)
          return { mode, state: status.state, rejected: true, ...counts }
        }
        if (mode === "api") {
          const { NodeHttpServer } = await import("@effect/platform-node")
          const { HttpApi, HttpApiBuilder } = await import("effect/unstable/httpapi")
          const { HttpRouter, HttpServerRequest } = await import("effect/unstable/http")
          const { McpApi } = await import("@/server/routes/instance/httpapi/groups/mcp")
          const { mcpHandlersBase, mcpMutationAuthorizationLayer } = await import(
            "@/server/routes/instance/httpapi/handlers/mcp"
          )
          const { authorizationLayer } = await import("@/server/routes/instance/httpapi/middleware/authorization")
          const { schemaErrorLayer } = await import("@/server/routes/instance/httpapi/middleware/schema-error")
          const { WorkspaceRoutingMiddleware, WorkspaceRouteContext, sanitizeLocalDirectory } = await import(
            "@/server/routes/instance/httpapi/middleware/workspace-routing"
          )
          const { WorkspaceV2 } = await import("@deepagent-code/core/workspace")
          const { Session } = await import("@/session/session")
          const { ServerAuth } = await import("@/server/auth")
          const { CorsConfig } = await import("@/server/cors")
          const { McpReadModel } = await import("@/mcp/read-model")
          const credentials = ServerAuth.Config.layer({
            username: "migration-fixture",
            password: Option.some("owned-fixture-password"),
          })
          const cors = Layer.succeed(CorsConfig, undefined)
          const route = Layer.succeed(
            WorkspaceRoutingMiddleware,
            WorkspaceRoutingMiddleware.of((effect) =>
              Effect.gen(function* () {
                const request = yield* HttpServerRequest.HttpServerRequest
                const url = new URL(request.url, "http://localhost")
                return yield* effect.pipe(
                  Effect.provideService(
                    WorkspaceRouteContext,
                    WorkspaceRouteContext.of({
                      directory: sanitizeLocalDirectory(url.searchParams.get("directory") ?? a),
                      ...(url.searchParams.get("workspace")
                        ? { workspaceID: WorkspaceV2.ID.make(url.searchParams.get("workspace")!) }
                        : {}),
                    }),
                  ),
                )
              }),
            ),
          )
          const web = HttpRouter.toWebHandler(
            HttpApiBuilder.layer(HttpApi.make("deepagent-code-instance").addHttpApi(McpApi)).pipe(
              Layer.provide(mcpHandlersBase),
              Layer.provide(authorizationLayer),
              Layer.provide(schemaErrorLayer),
              Layer.provide(mcpMutationAuthorizationLayer),
              Layer.provide(route),
              Layer.provide(credentials),
              Layer.provide(cors),
              Layer.provide(Layer.succeed(MCP.Service, mcp)),
              Layer.provide(Layer.succeed(Config.Service, cfg)),
              Layer.provide(Layer.succeed(InstanceStore.Service, instances)),
              Layer.provide(Layer.mock(Session.Service)({})),
              Layer.provide(
                Layer.succeed(
                  McpReadModel.Service,
                  McpReadModel.Service.of({
                    status: () => Effect.die("Unexpected display call"),
                    resources: () => Effect.die("Unexpected resource call"),
                    commands: () => Effect.die("Unexpected command call"),
                  }),
                ),
              ),
              Layer.provide(NodeHttpServer.layerHttpServices),
            ),
          )
          const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => web.handler(request) })
          const executionCensus = () =>
            Promise.all([
              Effect.runPromise(database.db.select({ count: count() }).from(SessionTable)),
              Effect.runPromise(database.db.select({ count: count() }).from(SessionInputTable)),
              Effect.runPromise(database.db.select({ count: count() }).from(WorkExecutionTable)),
              Effect.runPromise(database.db.select({ count: count() }).from(WorkDispatchReservationTable)),
              Effect.runPromise(database.db.select({ count: count() }).from(V2ProviderTurnReceiptTable)),
              Effect.runPromise(database.db.select({ count: count() }).from(WorkCountAcquisitionTable)),
            ]).then((rows) => rows.map((row) => row[0].count))
          const call = async (method: string, suffix: string, directory = a, body?: object, authorized = true) => {
            const url = new URL(`/mcp/same/${suffix}`, server.url)
            url.searchParams.set("directory", directory)
            const response = await fetch(url, {
              method,
              headers: {
                ...(authorized
                  ? {
                      authorization: `Basic ${Buffer.from("migration-fixture:owned-fixture-password").toString("base64")}`,
                    }
                  : {}),
                ...(body ? { "content-type": "application/json" } : {}),
              },
              ...(body ? { body: JSON.stringify(body) } : {}),
            })
            const text = await response.text()
            assert(!text.includes("secret://"))
            assert(!text.includes("fixture-a-client"))
            return { status: response.status, data: text ? JSON.parse(text) : undefined }
          }
          try {
            const executionBefore = await executionCensus()
            assert.deepEqual(executionBefore, [0, 0, 0, 0, 0, 0])
            const before = await fs.readFile(path.join(a, "deepagent-code.json"))
            assert.equal((await call("GET", "credentials/preview", a, undefined, false)).status, 401)
            assert.equal((await call("GET", "credentials/preview")).status, 503)
            await assert.rejects(fs.stat(LocalAuthority.installationPath()), { code: "ENOENT" })
            assert.deepEqual(await fs.readFile(path.join(a, "deepagent-code.json")), before)
            assert.equal((await call("POST", "credentials/initialize")).status, 200)
            const preview = await call("GET", "credentials/preview")
            assert.equal(preview.status, 200)
            assert.equal(preview.data.fields.length, 2)
            assert.equal(counts.put, 0)
            const mismatched = await fetch(
              new URL(`/mcp/local/credentials/commit?directory=${encodeURIComponent(a)}`, server.url),
              {
                method: "POST",
                headers: {
                  authorization: `Basic ${Buffer.from("migration-fixture:owned-fixture-password").toString("base64")}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({ previewID: preview.data.previewID, requestID: "wrong-name" }),
              },
            )
            assert.equal(mismatched.status, 409)
            assert.equal(counts.put, 0)
            const committed = await call("POST", "credentials/commit", a, {
              previewID: preview.data.previewID,
              requestID: "api-first",
            })
            assert.equal(committed.status, 200)
            assert.equal(committed.data.state, "committed")
            assert.equal(counts.put, 2)
            const after = await awaitBytes()
            assert.equal((await call("GET", "credentials/api-first")).status, 200)
            assert.equal(
              (
                await call("POST", "credentials/commit", a, {
                  previewID: preview.data.previewID,
                  requestID: "api-first",
                })
              ).status,
              200,
            )
            assert.equal((await call("POST", "credentials/api-first/reconcile")).status, 200)
            assert.equal(counts.put, 2)
            assert.deepEqual(await awaitBytes(), after)
            const old = await Effect.runPromise(
              identities.resolve({
                boundary: { kind: "implicit_local" },
                directory: AbsolutePath.make(b),
                project: { kind: "registered_root", observedProjectId: "global" },
              }),
            )
            assert.equal((await call("GET", "credentials/preview", b)).status, 503)
            const binding = await call("GET", "binding/preview", b)
            assert.equal(binding.status, 200)
            assert.equal(binding.data.old.locationKey, old.locationKey)
            assert.equal((await call("POST", "binding/repair", b, { previewID: binding.data.previewID })).status, 200)
            assert.equal((await call("GET", "credentials/preview", b)).status, 200)
            assert.equal((await call("GET", "credentials/api-first", b)).status, 409)
            assert.equal(counts.put, 2)
            assert.equal(counts.network, 0)
            assert.deepEqual(await executionCensus(), executionBefore)
            return {
              mode,
              actualHandlers: true,
              actualServices: true,
              middlewareRouteContext: "controlled-local",
              initialized: true,
              migrated: 2,
              repaired: true,
              exactRetryPutDelta: 0,
              wrongNameRejected: true,
              executionRows: executionBefore,
              ...counts,
            }
          } finally {
            await server.stop(true)
            await web.dispose()
          }
        }
        if (mode === "first-empty") {
          const before = await fs.readFile(path.join(a, "deepagent-code.json"))
          await assert.rejects(fs.stat(LocalAuthority.installationPath()), { code: "ENOENT" })
          const unavailable = await inDirectory(migration.preview("same").pipe(Effect.exit), a)
          assert(Exit.isFailure(unavailable))
          await assert.rejects(fs.stat(LocalAuthority.installationPath()), { code: "ENOENT" })
          assert.deepEqual(await fs.readFile(path.join(a, "deepagent-code.json")), before)
          const initialized = await inDirectory(migration.initialize("same"), a)
          assert.deepEqual(initialized, { name: "same", source: path.join(a, "deepagent-code.json") })
          assert.equal((await fs.stat(LocalAuthority.installationPath())).mode & 0o777, 0o600)
          assert.deepEqual(await fs.readFile(path.join(a, "deepagent-code.json")), before)
          assert.equal(counts.put, 0)
          const committed = await migrate("same", a, "first-empty")
          assert.equal(committed.state, "committed")
          assert.equal(committed.moved, 2)
          assert.equal(counts.put, 2)
          assert.equal(counts.network, 0)
          return {
            mode,
            previewWasReadonly: true,
            initialized: true,
            state: committed.state,
            moved: committed.moved,
            ...counts,
          }
        }
        if (mode === "binding-repair" || mode === "binding-unknown") {
          await Effect.runPromise(LocalAuthority.ensurePrivateInstallation())
          const boundary = { kind: "implicit_local" as const }
          const old = await Effect.runPromise(
            identities.resolve({
              boundary,
              directory: AbsolutePath.make(a),
              project: { kind: "registered_root", observedProjectId: "global" },
            }),
          )
          const before = await fs.readFile(path.join(a, "deepagent-code.json"))
          const unavailable = await inDirectory(migration.preview("same").pipe(Effect.exit), a)
          assert(Exit.isFailure(unavailable))
          const preview = await inDirectory(migration.previewBinding("same"), a)
          assert.equal(preview.old.locationKey, old.locationKey)
          assert.equal(preview.old.securityNamespaceId, old.securityNamespaceId)
          assert.equal(preview.old.locationObservedProjectId, "global")
          assert.equal(preview.old.projectObservedProjectId, "global")
          assert.notEqual(preview.nextObservedProjectId, "global")
          assert.deepEqual(await fs.readFile(path.join(a, "deepagent-code.json")), before)
          assert.equal(counts.put, 0)
          if (mode === "binding-unknown") {
            await Effect.runPromise(
              WorkAuthorityFixture.initialize().pipe(Effect.provideService(Database.Service, database)),
            )
            const original = WorkAuthorityFixture.binding("binding-unknown")
            const binding = {
              ...original,
              location: { directory: a },
              scope: {
                ...original.scope,
                securityNamespaceID: old.securityNamespaceId,
                projectScopeKey: old.projectScopeKey,
              },
            }
            await Effect.runPromise(
              WorkAuthority.reserve(database.db, { binding, now: WorkAuthorityFixture.NOW }).pipe(
                Effect.provide(WorkAuthorityFixture.verifier),
              ),
            )
            await Effect.runPromise(
              database.db
                .update(WorkExecutionTable)
                .set({ outcome: "unknown" })
                .where(eq(WorkExecutionTable.work_id, binding.workID))
                .run(),
            )
            const work = await Effect.runPromise(database.db.select().from(WorkExecutionTable))
            const blocked = await inDirectory(migration.repairBinding(preview.previewID).pipe(Effect.exit), a)
            assert(Exit.isFailure(blocked))
            const error = Cause.squash(blocked.cause)
            assert(error instanceof McpSecretMigration.Error)
            assert.equal(error.reason, "work_unsettled")
            assert.deepEqual(await Effect.runPromise(database.db.select().from(WorkExecutionTable)), work)
            assert.deepEqual(
              await Effect.runPromise(
                identities.inspectObservedProjectBinding({ boundary, directory: AbsolutePath.make(a) }),
              ),
              preview.old,
            )
            assert.deepEqual(await fs.readFile(path.join(a, "deepagent-code.json")), before)
            assert.equal(counts.put, 0)
            return { mode, rejected: true, code: error.reason, ...counts }
          }
          assert.equal((await inDirectory(migration.repairBinding(preview.previewID), a)).state, "repaired")
          const captured = await inDirectory(scopes.capture("same"), a)
          assert.equal(captured.binding.namespace, old.securityNamespaceId)
          assert.equal(captured.binding.location, old.locationKey)
          assert.equal(captured.binding.project, old.projectScopeKey)
          assert.equal((await inDirectory(migration.preview("same"), a)).fields.length, 2)
          assert.deepEqual(await fs.readFile(path.join(a, "deepagent-code.json")), before)
          assert.equal(counts.put, 0)
          assert.equal(counts.network, 0)
          return { mode, sameScope: true, secretPreviewAvailable: true, ...counts }
        }
        await setup(a)
        const beforePlan = await awaitBytes()
        const preview = await inDirectory(migration.preview("same"), a)
        assert.deepEqual(await awaitBytes(), beforePlan)
        assert.equal(preview.fields.length, 2)
        if (mode === "changed") {
          const file = path.join(a, "deepagent-code.json")
          const replacement = path.join(a, "replacement")
          await fs.writeFile(replacement, await fs.readFile(file))
          await fs.rename(replacement, file)
          const before = await fs.readFile(file)
          const exit = await inDirectory(
            migration.commit({ previewID: preview.previewID, requestID: "first-a" }).pipe(Effect.exit),
            a,
          )
          assert(Exit.isFailure(exit))
          assert.deepEqual(await fs.readFile(file), before)
          assert.equal(counts.put, 0)
          return { mode, rejected: true, ...counts }
        }
        if (mode === "stored-gap") {
          const exit = await inDirectory(
            migration.commit({ previewID: preview.previewID, requestID: "first-a" }).pipe(Effect.exit),
            a,
          )
          assert(Exit.isFailure(exit))
          assert.equal(counts.put, 2)
          const current = await inDirectory(migration.status("first-a"), a)
          assert.equal(current?.state, "stored")
          assert((await fs.readFile(path.join(a, "deepagent-code.json"), "utf8")).includes("external-edit"))
          return { mode, state: current?.state, ...counts }
        }
        assert.equal(
          (await inDirectory(migration.commit({ previewID: preview.previewID, requestID: "first-a" }), a)).state,
          "committed",
        )
        assert.equal((await migrate("local", a, "local-a")).moved, 1)
        await setup(b)
        assert.equal((await migrate("same", b, "first-b")).state, "committed")
        const aText = await fs.readFile(path.join(a, "deepagent-code.json"), "utf8")
        const aConfig = parse(aText)
        assert(aText.includes("// keep this comment"))
        assert.deepEqual(aConfig.mcp.sibling.command, ["retained"])
        assert(!aText.includes("fixture-a"))
        const ref = aConfig.mcp.same.headers.Authorization
        assert.equal(await inDirectory(migration.resolveValue("same", "headers", "Authorization", ref), a), "fixture-a")
        assert.equal(
          await inDirectory(
            migration.resolveValue("same", "oauth", "clientSecret", aConfig.mcp.same.oauth.clientSecret),
            a,
          ),
          "fixture-a-client",
        )
        assert.equal(
          await inDirectory(
            migration.resolveValue(
              "local",
              "environment",
              "GITHUB_PERSONAL_ACCESS_TOKEN",
              aConfig.mcp.local.environment.GITHUB_PERSONAL_ACCESS_TOKEN,
            ),
            a,
          ),
          "fixture-a-env",
        )
        const bConfig = parse(await fs.readFile(path.join(b, "deepagent-code.json"), "utf8"))
        assert.notEqual(ref, bConfig.mcp.same.headers.Authorization)
        const borrowed = await inDirectory(
          migration.resolveValue("same", "headers", "Authorization", ref).pipe(Effect.exit),
          b,
        )
        assert(Exit.isFailure(borrowed))
        const bare = await Effect.runPromise(secrets.resolve(ref).pipe(Effect.exit))
        assert(Exit.isFailure(bare))
        const before = await awaitBytes()
        const put = counts.put
        assert.equal(
          (await inDirectory(migration.commit({ previewID: preview.previewID, requestID: "first-a" }), a)).state,
          "committed",
        )
        assert.equal(counts.put, put)
        assert.deepEqual(await awaitBytes(), before)
        assert.equal(counts.network, 0)
        if (mode === "runtime") {
          const file = path.join(b, "deepagent-code.json")
          const before = parse(await fs.readFile(file, "utf8"))
          before.mcp.same.headers.Authorization = ref
          before.mcp.same.oauth = false
          before.mcp.same.enabled = true
          await fs.writeFile(file, JSON.stringify(before))
          const result = await Effect.runPromise(instances.provide({ directory: b }, mcp.add("same", before.mcp.same)))
          assert("same" in result.status)
          assert.equal(result.status.same.status, "failed")
          assert.equal(physical.http, 0)
        }
        return {
          mode,
          distinctScopes: true,
          moved: 5,
          bareRejected: true,
          exactRetryPutDelta: counts.put - put,
          ...counts,
          physicalHTTP: physical.http,
        }

        async function awaitBytes() {
          return {
            configA: await fs.readFile(path.join(a, "deepagent-code.json")),
            ledger: await fs.readFile(McpSecretMigration.ledgerPath()).catch((error: unknown) => {
              if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
                return undefined
              throw error
            }),
          }
        }
      },
      catch: (error) => error,
    })
  }).pipe(Effect.scoped, Effect.provide(layer)),
)
if (Exit.isFailure(result)) {
  await listener?.stop(true)
  console.error(Cause.pretty(result.cause))
  process.exit(1)
}
assert.equal(counts.network, 0)
await listener?.stop(true)
console.log(JSON.stringify({ fixture: "mcp-secret-migration", ...result.value }))
