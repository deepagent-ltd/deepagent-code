import { test, expect } from "bun:test"
import path from "node:path"
import fs from "node:fs"
import { Effect } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { migrations } from "@deepagent-code/core/database/migration.gen"
import { DatabaseUpgradeRun } from "@deepagent-code/core/database/upgrade-run"
import { ContractDigest } from "@deepagent-code/core/contract/digest"
import { cliIt } from "../../lib/cli-process"
import { CompositionDigest } from "../../../src/effect/composition-digest"
import { V2RunnerFrame } from "../../../src/session/v2-runner-frame"

// RI-44 packaged smoke: the packaged binary's HTTP root must expose a composition digest that is
// structurally the source composition digest — same augmented runner frame, same embedded migration
// registry, same canonical digest recomputation. Runs only when DEEPAGENT_CODE_TEST_BINARY points
// at a packaged artifact.

const packagedBinary = process.env.DEEPAGENT_CODE_TEST_BINARY

if (!packagedBinary) {
  test.skip("packaged composition digest smoke requires DEEPAGENT_CODE_TEST_BINARY", () => {})
} else {
  cliIt.live(
    "packaged serve exposes the source-consistent root composition digest",
    ({ deepagentCode, home }) =>
      Effect.gen(function* () {
        const databaseName = "packaged-composition-digest.db"
        const server = yield* deepagentCode.serve({
          hostname: "127.0.0.1",
          env: { DEEPAGENT_CODE_DB: databaseName },
        })
        const response = yield* Effect.promise(() => fetch(`${server.url}/composition/digest`))
        expect(response.status).toBe(200)
        const body = (yield* Effect.promise(() => response.json())) as CompositionDigest.Record

        expect(body.version).toBe(1)
        expect(body.digest).toMatch(/^[0-9a-f]{64}$/)
        expect(
          CompositionDigest.compute({
            sessionOwner: body.sessionOwner,
            toolRegistry: body.toolRegistry,
            database: body.database,
            locationHost: body.locationHost,
          }),
        ).toBe(body.digest)

        // The packaged root runs the same augmented runner frame as source.
        expect(body.sessionOwner.execution).toBe(V2RunnerFrame.frameIdentity.sessionOwner.execution)
        expect(body.sessionOwner.placement).toBe(V2RunnerFrame.frameIdentity.sessionOwner.placement)
        expect(body.sessionOwner.coordination).toBe(V2RunnerFrame.frameIdentity.sessionOwner.coordination)
        expect(body.sessionOwner.services).toEqual(
          [
            "@deepagent-code/v2/Session",
            "@deepagent-code/v2/SessionExecution",
            "@deepagent-code/v2/SessionRestart",
            "@deepagent-code/v2/SessionRuntimeStatus",
            "@deepagent-code/v2/SessionStore",
          ].toSorted(),
        )
        expect(body.locationHost.host).toBe(V2RunnerFrame.frameIdentity.locationHost.host)
        expect(body.locationHost.seams).toEqual(V2RunnerFrame.frameIdentity.locationHost.seams)

        // The packaged binary embeds the same migration registry as source and opened the
        // configured database file.
        expect(body.database.migrationRegistryDigest).toBe(DatabaseUpgradeRun.registryDigest(migrations))
        // bun:sqlite resolves the macOS /var symlink on open, so PRAGMA database_list reports
        // the realpath; compare against the resolved expectation (identical on Linux).
        expect(body.database.path).toBe(path.join(fs.realpathSync(home), ".deepagent", "code", databaseName))
        expect(body.database.bootstrapDigest).toMatch(/^[0-9a-f]{64}$/)
        expect(body.database.readerProtocol).toBe(Database.SupportedReaderProtocol)
        expect(body.database.writerProtocol).toBe(Database.SupportedWriterProtocol)

        // The packaged tool registry carries the core built-ins under the stable-set hash.
        expect(body.toolRegistry.ids).toEqual([...body.toolRegistry.ids].toSorted())
        expect(body.toolRegistry.count).toBe(body.toolRegistry.ids.length)
        expect(body.toolRegistry.digest).toBe(
          ContractDigest.contentDigest({ kind: "tool-registry", ids: body.toolRegistry.ids }),
        )
        for (const id of ["read", "edit", "write", "glob", "grep"]) expect(body.toolRegistry.ids).toContain(id)
      }),
    { timeout: 120_000 },
  )
}
