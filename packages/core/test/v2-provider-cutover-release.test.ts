import { describe, expect, test } from "bun:test"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"
import { ProjectV2 } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionSchema } from "../src/session/schema"
import { SessionTable } from "../src/session/sql"
import { V2ProviderTurn } from "../src/session/runner/v2-provider-turn"
import { V2ProviderTurnReceiptTable } from "../src/session/runner/v2-provider-turn.sql"
import { tmpdir } from "./fixture/tmpdir"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const run = <A, E>(filename: string, effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped))

describe("V2 provider owner release qualification", () => {
  test("upgrades pre-V2 and pre-campaign disk databases without losing durable sessions", async () => {
    await using tmp = await tmpdir()
    const cuts = ["20260813041200_v2_provider_shadow_authority", "20260813120346_v2_provider_parity_campaign"] as const

    for (const cut of cuts) {
      const filename = `${tmp.path}/${cut}.sqlite`
      await run(
        filename,
        Effect.gen(function* () {
          const db = yield* makeDb
          const cutIndex = migrations.findIndex((migration) => migration.id === cut)
          expect(cutIndex).toBeGreaterThan(0)
          yield* DatabaseMigration.applyOnly(db, migrations.slice(0, cutIndex))

          const projectID = ProjectV2.ID.make(`project-${cut}`)
          const sessionID = SessionSchema.ID.make(`ses_${cut}`)
          yield* db
            .insert(ProjectTable)
            .values({ id: projectID, worktree: AbsolutePath.make(tmp.path), sandboxes: [] })
            .run()
          yield* db
            .insert(SessionTable)
            .values({
              id: sessionID,
              project_id: projectID,
              slug: cut,
              directory: AbsolutePath.make(tmp.path),
              title: "V2 cutover upgrade",
              version: "pre-v2",
            })
            .run()

          yield* DatabaseMigration.applyOnly(db, migrations)
          expect(
            yield* db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, sessionID)).get(),
          ).toEqual({ id: sessionID })
          expect(
            yield* db.get<{ count: number }>(
              sql`SELECT count(*) AS count FROM session_v2_provider_turn_receipt WHERE session_id = ${sessionID}`,
            ),
          ).toEqual({ count: 0 })
          expect(yield* V2ProviderTurn.ownerQualified(db)).toBe(true)

          yield* DatabaseMigration.applyOnly(db, migrations)
          expect(
            yield* db.get<{ count: number }>(
              sql`SELECT count(*) AS count FROM migration WHERE id = ${migrations.at(-1)!.id}`,
            ),
          ).toEqual({ count: 1 })
        }),
      )
    }
  })

  test("takes over an expired process owner without replay and leaves a rollback-safe database", async () => {
    await using tmp = await tmpdir()
    const filename = `${tmp.path}/takeover.sqlite`
    const marker = `${tmp.path}/physical-dispatch.json`
    const fixture = new URL("./fixture/v2-provider-owner-process.ts", import.meta.url)
    const first = Bun.spawn([process.execPath, fixture.pathname, "dispatch", filename, marker], {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    })
    const firstOutput = await new Response(first.stdout).text()
    const firstError = await new Response(first.stderr).text()
    expect(await first.exited, firstError).toBe(0)
    const dispatched = JSON.parse(firstOutput) as { receiptId: string }

    await Bun.sleep(650)
    const second = Bun.spawn([process.execPath, fixture.pathname, "recover", filename, marker, dispatched.receiptId], {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    })
    const secondOutput = await new Response(second.stdout).text()
    const secondError = await new Response(second.stderr).text()
    expect(await second.exited, secondError).toBe(0)
    expect(JSON.parse(secondOutput)).toEqual({
      state: "indeterminate_after_crash",
      errorCode: "owner_lost_after_dispatch",
      recovered: 0,
      activeV2: 0,
      oldOwnerHeartbeat: "provider_owner_lease_not_live",
      physicalDispatches: 1,
    })
  }, 15_000)
})
