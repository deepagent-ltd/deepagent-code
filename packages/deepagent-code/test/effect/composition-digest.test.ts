import { expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import path from "node:path"
import { Flag } from "@deepagent-code/core/flag/flag"
import { Database } from "@deepagent-code/core/database/database"
import { migrations } from "@deepagent-code/core/database/migration.gen"
import { DatabaseUpgradeRun } from "@deepagent-code/core/database/upgrade-run"
import { ContractDigest } from "@deepagent-code/core/contract/digest"
import { Server } from "../../src/server/server"
import { AppRuntime, compositionDigest } from "../../src/effect/app-runtime"
import { CompositionDigest } from "../../src/effect/composition-digest"
import { RuntimeIntegrityIdentity } from "../../src/effect/runtime-integrity-identity"
import { V2RunnerFrame } from "../../src/session/v2-runner-frame"
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
  expect(record.version).toBe(1)
  expect(record.digest).toMatch(/^[0-9a-f]{64}$/)
  // The wire digest is the canonical recomputation over its own four facets.
  expect(
    CompositionDigest.compute({
      sessionOwner: record.sessionOwner,
      toolRegistry: record.toolRegistry,
      database: record.database,
      locationHost: record.locationHost,
    }),
  ).toBe(record.digest)
  // The database facet is bound to core's migration registry digest mechanism.
  expect(record.database.migrationRegistryDigest).toBe(DatabaseUpgradeRun.registryDigest(migrations))
  expect(record.database.bootstrapDigest).toMatch(/^[0-9a-f]{64}$/)
  // The tool facet is the stable hash of the sorted registered tool-id set.
  expect(record.toolRegistry.ids).toEqual([...record.toolRegistry.ids].toSorted())
  expect(record.toolRegistry.count).toBe(record.toolRegistry.ids.length)
  expect(record.toolRegistry.digest).toBe(ContractDigest.contentDigest({ kind: "tool-registry", ids: record.toolRegistry.ids }))
  expect(record.toolRegistry.ids).toContain("read")
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

test(
  "HTTP server root and AppRuntime root expose the identical composition digest",
  async () => {
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const http = await httpDigest(listener.url)
      const app = await compositionDigest()
      // RI-36/RI-39: per-facet equality across the two real roots — session owner, tool registry,
      // database, Location host, and therefore the top-level digest.
      expect(app).toEqual(http)
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
      await listener.stop(true)
    }
  },
  180_000,
)

test(
  "roots opened on different databases digest differently (and identically on every other facet)",
  async () => {
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
  },
  180_000,
)

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
    toolRegistry: { count: 2, ids: ["read", "write"], digest: "t".repeat(64) },
    database: {
      path: "/data/deepagent-code.db",
      migrationRegistryDigest: "m".repeat(64),
      bootstrapDigest: "b".repeat(64),
      readerProtocol: 3,
      writerProtocol: 3,
    },
    locationHost: { host: "host-a", map: "@deepagent-code/example/LocationServiceMap", idleTimeToLive: "60 minutes", seams: ["s1"] },
  }
  const digest = CompositionDigest.compute(base)
  expect(digest).toMatch(/^[0-9a-f]{64}$/)
  expect(
    CompositionDigest.compute({
      ...base,
      toolRegistry: { ...base.toolRegistry, count: 3, ids: [...base.toolRegistry.ids, "extra_tool"] },
    }),
  ).not.toBe(digest)
  expect(CompositionDigest.compute({ ...base, database: { ...base.database, path: "/data/other.db" } })).not.toBe(digest)
  expect(CompositionDigest.compute({ ...base, locationHost: { ...base.locationHost, host: "core/default-location-host" } })).not.toBe(
    digest,
  )
  expect(CompositionDigest.compute({ ...base, sessionOwner: { ...base.sessionOwner, placement: "clustered" } })).not.toBe(digest)
  const reordered: CompositionDigest.Facets = {
    locationHost: base.locationHost,
    database: base.database,
    toolRegistry: base.toolRegistry,
    sessionOwner: base.sessionOwner,
  }
  expect(CompositionDigest.compute(reordered)).toBe(digest)
})

test(
  "the incident-only maintenance shell has no composition and answers a typed 503",
  async () => {
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
  },
  180_000,
)
