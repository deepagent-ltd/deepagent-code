import { expect, test } from "bun:test"
import { Cause, ConfigProvider, Context, Effect, Exit, Layer, Schema } from "effect"
import path from "node:path"
import { createHash } from "node:crypto"
import { HttpRouter } from "effect/unstable/http"
import { Flag } from "@deepagent-code/core/flag/flag"
import { Database } from "@deepagent-code/core/database/database"
import { migrations } from "@deepagent-code/core/database/migration.gen"
import { DatabaseUpgradeRun } from "@deepagent-code/core/database/upgrade-run"
import { ProxyTenantTable } from "@deepagent-code/core/proxy/sql"
import { ContractDigest } from "@deepagent-code/core/contract/digest"
import { ApplicationTools } from "@deepagent-code/core/tool/application-tools"
import { Server } from "../../src/server/server"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { gatewayServiceTags } from "../../src/server/routes/instance/httpapi/handlers/gateway-chat"
import { AppRuntime, compositionDigest } from "../../src/effect/app-runtime"
import { Root } from "../../src/effect/root"
import { CompositionDigest } from "../../src/effect/composition-digest"
import { RuntimeIntegrityIdentity } from "../../src/effect/runtime-integrity-identity"
import { V2RunnerFrame } from "../../src/session/v2-runner-frame"
import { adaptCustomTool } from "../../src/tool/custom-tool-adapter"
import { MaintenancePaths } from "../../src/server/routes/instance/httpapi/groups/maintenance"
import { tmpdir } from "../fixture/fixture"
import { seedIndeterminateProviderAuthority } from "../fixture/provider-recovery"

// RI-36/RI-39/RI-44 composition oracle: the two REAL composition roots (HTTP server route graph,
// AppRuntime) share `V2RunnerFrame.sessionRuntimeLayer`, so their composition digests must compare
// equal facet by facet. No mocks — every digest below comes from a real booted root.

async function httpDigest(url: URL): Promise<CompositionDigest.Record> {
  const response = await fetch(new URL(MaintenancePaths.compositionDigest, url))
  expect(response.status).toBe(200)
  return (await response.json()) as CompositionDigest.Record
}

function expectWireInvariants(record: CompositionDigest.Record) {
  expect(record.version).toBe(2)
  expect(record.digest).toMatch(/^[0-9a-f]{64}$/)
  // The wire digest is the canonical recomputation over its own facets.
  expect(
    CompositionDigest.compute({
      sessionOwner: record.sessionOwner,
      v2Registry: record.v2Registry,
      authoritySurface: record.authoritySurface,
      database: record.database,
      locationHost: record.locationHost,
    }),
  ).toBe(record.digest)
  // The database facet is bound to core's migration registry digest mechanism.
  expect(record.database.migrationRegistryDigest).toBe(DatabaseUpgradeRun.registryDigest(migrations))
  expect(record.database.bootstrapDigest).toMatch(/^[0-9a-f]{64}$/)
  expect(record.v2Registry.applicationTools.ids).toEqual([...record.v2Registry.applicationTools.ids].toSorted())
  expect(record.v2Registry.applicationTools.count).toBe(record.v2Registry.applicationTools.ids.length)
  expect(record.v2Registry.applicationTools.digest).toBe(
    ContractDigest.contentDigest({
      kind: "application-tools",
      ids: record.v2Registry.applicationTools.ids,
      rejected: record.v2Registry.applicationTools.rejected,
    }),
  )
  expect(record.v2Registry.materialized.ids).toEqual([...record.v2Registry.materialized.ids].toSorted())
  expect(record.v2Registry.materialized.count).toBe(record.v2Registry.materialized.ids.length)
  expect(
    record.v2Registry.materialized.effectKinds.readOnly + record.v2Registry.materialized.effectKinds.mutating,
  ).toBe(record.v2Registry.materialized.count)
  expect(record.v2Registry.materialized.ids).toContain("read")
  expect(record.v2Registry.legacyEgress.digest).toBe(
    ContractDigest.contentDigest({ kind: "tool-registry", ids: record.v2Registry.legacyEgress.ids }),
  )
  expect(record.authoritySurface).toEqual(Root.authoritySurface)
  // The session owner facet is the live-resolved core owner graph.
  expect(record.sessionOwner.services).toEqual(
    [
      "@deepagent-code/v2/Session",
      "@deepagent-code/v2/SessionExecution",
      "@deepagent-code/v2/SessionRestart",
      "@deepagent-code/v2/SessionRuntimeStatus",
      "@deepagent-code/v2/SessionStore",
    ].toSorted(),
  )
}

test("HTTP server root and AppRuntime root expose the identical composition digest", async () => {
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  try {
    const http = await httpDigest(listener.url)
    const app = await compositionDigest()
    const root = await Root.compositionDigest()
    const embedded = await Server.Default().app.request(new URL(MaintenancePaths.compositionDigest, "http://localhost"))
    expect(embedded.status).toBe(200)
    const embeddedDigest = (await embedded.json()) as CompositionDigest.Record
    // RI-36/RI-39: per-facet equality across the two real roots — session owner, tool registry,
    // database, Location host, and therefore the top-level digest.
    expect(app).toEqual(http)
    expect(root).toEqual(http)
    expect(embeddedDigest).toEqual(http)
    const bareCore = (await import("@deepagent-code/server/routes")).webHandler()
    try {
      const response = await bareCore.handler(
        new Request("http://localhost/health/composition"),
        Context.empty() as never,
      )
      expect(response.status).toBe(200)
      const unqualified = await response.json()
      expect(unqualified).toMatchObject({
        qualification: "unqualified",
        locationHost: { host: "core/default-location-host", mcpBridge: false, pluginBridge: false },
      })
      expect(unqualified.digest).not.toBe(http.digest)
    } finally {
      await bareCore.dispose()
    }
    expectWireInvariants(http)
    // RI-44: both roots run the AUGMENTED runner frame, not the core default host.
    expect(http.sessionOwner.execution).toBe(V2RunnerFrame.frameIdentity.sessionOwner.execution)
    expect(http.sessionOwner.placement).toBe(V2RunnerFrame.frameIdentity.sessionOwner.placement)
    expect(http.sessionOwner.coordination).toBe(V2RunnerFrame.frameIdentity.sessionOwner.coordination)
    expect(http.locationHost.host).toBe(V2RunnerFrame.frameIdentity.locationHost.host)
    expect(http.locationHost.seams).toEqual(V2RunnerFrame.frameIdentity.locationHost.seams)
    expect(http.database.path).toBe(":memory:")
    const runtimeIdentity = await AppRuntime.runPromise(RuntimeIntegrityIdentity.current)
    const runtimeContext = await AppRuntime.runPromise(Effect.context())
    const resolvedIdentity = await AppRuntime.runPromise(RuntimeIntegrityIdentity.resolver.resolve(runtimeContext))
    expect(runtimeIdentity.rootCompositionDigest).toBe(app.digest)
    expect(resolvedIdentity).toEqual(runtimeIdentity)
    expect(runtimeIdentity.databaseSchemaDigest).toBe(app.database.migrationRegistryDigest)
    expect(runtimeIdentity.packageDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(runtimeIdentity.schemaDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(runtimeIdentity.eventSchemaDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(runtimeIdentity.capabilityManifestDigest).toMatch(/^[0-9a-f]{64}$/)
  } finally {
    await Server.disposeDefault()
    await listener.stop(true)
  }
}, 180_000)

test("gateway service inventory is resolved by the qualified server root", async () => {
  await using root = await tmpdir()
  const original = Flag.DEEPAGENT_CODE_DB
  Flag.DEEPAGENT_CODE_DB = path.join(root.path, "gateway-composition.db")
  try {
    await Effect.runPromise(Effect.gen(function* () {
      yield* (yield* Database.Service).db.insert(ProxyTenantTable).values({
        id: "composition-tenant",
        key_hash: createHash("sha256").update("sk-composition-tenant").digest("hex"),
        key_fingerprint: "composition-key",
        directory: root.path,
        model_allowlist: [],
        tier: "passthrough",
        quota_requests_per_minute: 1,
        quota_tokens_per_day: 1,
        lane_limit: 1,
        deadline_ms: 1_000,
        enabled: true,
        created_at: Date.now(),
        updated_at: Date.now(),
      })
    }).pipe(Effect.provide(Database.defaultLayer)))
    const web = HttpRouter.toWebHandler(HttpApiApp.createRoutes().pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ DEEPAGENT_CODE_GATEWAY: true }))),
    ), { disableLogger: true })
    try {
      expect(Object.values(gatewayServiceTags).map((service) => service.key).toSorted()).toEqual([
        "@deepagent-code/Auth", "@deepagent-code/EventV2Bridge", "@deepagent-code/InstanceStore",
        "@deepagent-code/LLMClient", "@deepagent-code/ModelsDev", "@deepagent-code/Provider",
        "@deepagent-code/v2/Session", "@deepagent-code/v2/storage/Database",
      ] satisfies (typeof gatewayServiceTags)[keyof typeof gatewayServiceTags]["key"][])
      const before = await web.handler(new Request("http://localhost/composition/digest"), HttpApiApp.context)
      expect(before.status).toBe(200)
      const composition = (await before.json()) as CompositionDigest.Record
      expectWireInvariants(composition)
      const gateway = await web.handler(new Request("http://localhost/v1/models", {
        headers: { authorization: "Bearer sk-composition-tenant" },
      }), HttpApiApp.context)
      expect(gateway.status).toBe(200)
      expect(await gateway.json()).toEqual({ object: "list", data: [] })
      const after = await web.handler(new Request("http://localhost/composition/digest"), HttpApiApp.context)
      expect(after.status).toBe(200)
      expect(await after.json()).toEqual(composition)
    } finally {
      await web.dispose()
    }
  } finally {
    Flag.DEEPAGENT_CODE_DB = original
  }
}, 180_000)

test("roots opened on different databases digest differently (and identically on every other facet)", async () => {
  await using root = await tmpdir()
  const original = Flag.DEEPAGENT_CODE_DB
  const first = path.join(root.path, "composition-a.db")
  const second = path.join(root.path, "composition-b.db")
  Flag.DEEPAGENT_CODE_DB = first
  const listenerA = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  Flag.DEEPAGENT_CODE_DB = second
  const listenerB = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  try {
    const digestA = await httpDigest(listenerA.url)
    const digestB = await httpDigest(listenerB.url)
    // Each root reports the database file its own live connection has open.
    expect(digestA.database.path).toBe(first)
    expect(digestB.database.path).toBe(second)
    expect(digestA.digest).not.toBe(digestB.digest)
    const { digest: _topA, database: databaseA, ...restA } = digestA
    const { digest: _topB, database: databaseB, ...restB } = digestB
    expect(restA).toEqual(restB)
    const { path: _pathA, ...databaseRestA } = databaseA
    const { path: _pathB, ...databaseRestB } = databaseB
    expect(databaseRestA).toEqual(databaseRestB)
  } finally {
    Flag.DEEPAGENT_CODE_DB = original
    await listenerA.stop(true)
    await listenerB.stop(true)
  }
}, 180_000)

test("a scoped plugin fixture changes the live application-tool facet until it unloads", async () => {
  const baseline = await compositionDigest()
  const fixture = adaptCustomTool({
    id: "fixture_plugin_tool",
    description: "fixture plugin tool",
    parameters: Schema.Unknown,
    execute: () => Effect.succeed({ title: "", metadata: {}, output: "fixture" }),
  })
  expect(fixture).toBeDefined()
  if (!fixture) return
  const loaded = await AppRuntime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* ApplicationTools.Service.use((applications) => applications.register({ fixture_plugin_tool: fixture }))
        return yield* CompositionDigest.current
      }),
    ),
  )
  expect(loaded.v2Registry.applicationTools.ids).toContain("fixture_plugin_tool")
  expect(loaded.v2Registry.applicationTools.count).toBe(baseline.v2Registry.applicationTools.count + 1)
  expect(loaded.v2Registry.applicationTools.digest).not.toBe(baseline.v2Registry.applicationTools.digest)
  expect((await compositionDigest()).v2Registry.applicationTools).toEqual(baseline.v2Registry.applicationTools)
}, 180_000)

test("a context missing the session owner graph cannot produce a digest", async () => {
  // Deliberately under-provisioned probe: the requirement channel is erased so the digest runs
  // against an empty context and must fail closed on the first missing owner service.
  const underprovisioned = CompositionDigest.current as Effect.Effect<CompositionDigest.Record, never, never>
  const exit = await Effect.runPromiseExit(underprovisioned)
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Service not found")
})

test("the top-level digest moves when any single facet changes and is key-order stable", () => {
  const base: CompositionDigest.Facets = {
    sessionOwner: {
      execution: "core/session/execution/local:SessionExecutionLocal",
      placement: "process-local:session-id",
      coordination: "core/session/run-coordinator:SessionRunCoordinator",
      services: ["@deepagent-code/v2/Session", "@deepagent-code/v2/SessionExecution"],
    },
    v2Registry: {
      applicationTools: { count: 0, ids: [], digest: "a".repeat(64), rejected: 0 },
      materialized: { count: 2, ids: ["read", "write"], effectKinds: { readOnly: 1, mutating: 1 } },
      legacyEgress: { count: 2, ids: ["read", "write"], digest: "t".repeat(64) },
    },
    authoritySurface: Root.authoritySurface,
    database: {
      path: "/data/deepagent-code.db",
      migrationRegistryDigest: "m".repeat(64),
      bootstrapDigest: "b".repeat(64),
      readerProtocol: 3,
      writerProtocol: 3,
    },
    locationHost: {
      host: "host-a",
      map: "@deepagent-code/example/LocationServiceMap",
      idleTimeToLive: "60 minutes",
      seams: ["s1"],
    },
  }
  const digest = CompositionDigest.compute(base)
  expect(digest).toMatch(/^[0-9a-f]{64}$/)
  expect(
    CompositionDigest.compute({
      ...base,
      v2Registry: {
        ...base.v2Registry,
        materialized: {
          ...base.v2Registry.materialized,
          count: 3,
          ids: [...base.v2Registry.materialized.ids, "extra_tool"],
        },
      },
    }),
  ).not.toBe(digest)
  expect(CompositionDigest.compute({ ...base, database: { ...base.database, path: "/data/other.db" } })).not.toBe(
    digest,
  )
  expect(
    CompositionDigest.compute({ ...base, locationHost: { ...base.locationHost, host: "core/default-location-host" } }),
  ).not.toBe(digest)
  expect(
    CompositionDigest.compute({ ...base, sessionOwner: { ...base.sessionOwner, placement: "clustered" } }),
  ).not.toBe(digest)
  expect(
    CompositionDigest.compute({ ...base, authoritySurface: { ...base.authoritySurface, legacyPromptMounted: false } }),
  ).not.toBe(digest)
  expect(
    CompositionDigest.compute({
      ...base,
      v2Registry: {
        ...base.v2Registry,
        applicationTools: { ...base.v2Registry.applicationTools, rejected: 1 },
      },
    }),
  ).not.toBe(digest)
  const reordered: CompositionDigest.Facets = {
    locationHost: base.locationHost,
    database: base.database,
    v2Registry: base.v2Registry,
    authoritySurface: base.authoritySurface,
    sessionOwner: base.sessionOwner,
  }
  expect(CompositionDigest.compute(reordered)).toBe(digest)
})

test("the incident-only maintenance shell has no composition and answers a typed 503", async () => {
  await using root = await tmpdir()
  const filename = path.join(root.path, "incident-digest.db")
  const authority = await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db.run("UPDATE event_sync_backfill SET completed_at = NULL WHERE id = 1")
      return yield* seedIndeterminateProviderAuthority(database.db, {
        sessionId: "ses_digest_incident",
        activityId: "act_digest_incident",
        attemptId: "att_digest_incident",
        requestHash: "d".repeat(64),
      })
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
  )
  expect(authority.attempt.sessionId).toBe("ses_digest_incident")
  const original = Flag.DEEPAGENT_CODE_DB
  Flag.DEEPAGENT_CODE_DB = filename
  try {
    expect(await Database.bootstrap(filename)).toMatchObject({ mode: "read_only_recovery" })
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const response = await fetch(new URL(MaintenancePaths.compositionDigest, listener.url))
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({
        name: "ApiUnavailable",
        data: { code: "service_unavailable", actual: "read_only_recovery" },
      })
    } finally {
      await listener.stop(true)
    }
  } finally {
    Flag.DEEPAGENT_CODE_DB = original
  }
}, 180_000)
