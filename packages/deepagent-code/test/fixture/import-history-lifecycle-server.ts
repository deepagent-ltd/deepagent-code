import path from "node:path"
import { appendFileSync } from "node:fs"
import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { HttpServer } from "effect/unstable/http"
import { Database } from "@deepagent-code/core/database/database"
import { ImportJob } from "@deepagent-code/core/import-job"
import { Hash } from "@deepagent-code/core/util/hash"
import { importServer, importSource } from "./import-job"
import { importFixtureSourceInventory, publishImportFixturePacket } from "../../../app/test/components/fixture/import-control"

const root = process.argv[2]!
const stage = (phase: string) => appendFileSync(path.join(root, "startup.jsonl"),
  JSON.stringify({ phase, at: Date.now(), elapsedMs: performance.now() }) + "\n", { mode: 0o600 })
stage("fixture-module-loaded")
const count = Number(process.argv[3] ?? "400")
const abort = new AbortController()
process.once("SIGTERM", () => abort.abort())
stage("acquiring-http-and-database")
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      stage("http-and-database-acquired")
      const db = (yield* Database.Service).db
      const names = (yield* db
        .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .pipe(Effect.orDie))
        .filter((row) => row.name !== "import_job")
        .map((row) => row.name)
        .sort()
      const census = () =>
        Effect.forEach(
          names,
          (name) =>
            db.all(`SELECT * FROM "${name.replaceAll('"', '""')}"`).pipe(
              Effect.orDie,
              Effect.map((rows) => ({
                name,
                hash: Hash.sha256(JSON.stringify(rows.map((row) => JSON.stringify(row)).sort())),
              })),
            ),
          { concurrency: 1 },
        )
      const before = yield* census()
      stage("initial-database-census-complete")
      const sourcePath = yield* Effect.promise(() => importSource(root, "claude", count))
      const packetCount = Math.min(count, 2)
      const packetSourcePath = count
        ? yield* Effect.promise(() => importSource(path.join(root, "packet"), "claude", packetCount))
        : sourcePath
      if (count)
        yield* Effect.promise(async () => {
          for (const source of [sourcePath, packetSourcePath]) {
            await Bun.write(
              path.join(source, "projects/fixture/memory/context.md"),
              "# Private memory\nKeep every import in its copy target.\n",
            )
            await Bun.write(
              path.join(source, "skills/lifecycle/SKILL.md"),
              "# Private skill\nInspect the original receipt before using it.\n",
            )
            await Bun.write(path.join(source, "skills/lifecycle/raw.bin"), new Uint8Array([0, 255, 128]))
          }
        })
      const sources = count ? [sourcePath, packetSourcePath] : []
      const sourceBefore = yield* Effect.promise(() => Promise.all(sources.map(importFixtureSourceInventory)))
      stage("source-inventory-complete")
      const url = HttpServer.formatAddress((yield* HttpServer.HttpServer).address)
      yield* Effect.promise(() =>
        publishImportFixturePacket(path.join(root, "ready.json"), {
          url,
          sourcePath,
          count,
          packetSourcePath,
          packetCount,
        }),
      )
      stage("ready-published")
      // This only observes real destination receipts. It never pauses a writer,
      // changes a job row, or fabricates a completed/partial state for the UI.
      for (;;) {
        yield* Effect.sleep("10 millis")
        const monitor = Bun.file(path.join(root, "monitor.json"))
        if (yield* Effect.promise(() => monitor.exists())) {
          const input = yield* Effect.promise(() => monitor.json() as Promise<{ jobID: string }>)
          const row = yield* ImportJob.get(input.jobID)
          if (
            row?.target &&
            row.source_digest &&
            !(yield* Effect.promise(() => Bun.file(path.join(root, "first-commit.json")).exists()))
          ) {
            const receipt = yield* ImportJob.receipts({
              filename: row.target.dbPath,
              jobID: row.job_id,
              sourceDigest: row.source_digest,
            }).pipe(Effect.option)
            if (receipt._tag === "Some" && receipt.value.count > 0)
              yield* Effect.promise(() =>
                publishImportFixturePacket(path.join(root, "first-commit.json"), {
                  jobID: row.job_id,
                  state: row.state,
                  count: receipt.value.count,
                }),
              )
          }
        }
        const inspect = Bun.file(path.join(root, "inspect.json"))
        if (!(yield* Effect.promise(() => inspect.exists()))) continue
        const input = yield* Effect.promise(() => inspect.json() as Promise<{ jobID: string; name: string }>)
        const row = yield* ImportJob.get(input.jobID)
        if (!row?.target || !row.source_digest) return yield* Effect.die("Missing original import target")
        const proof = yield* ImportJob.receipts({
          filename: row.target.dbPath,
          jobID: row.job_id,
          sourceDigest: row.source_digest,
          includeResults: true,
        })
        const after = yield* census()
        const sourceAfter = yield* Effect.promise(() => Promise.all(sources.map(importFixtureSourceInventory)))
        const target = yield* Effect.promise(async () => {
          const { Database } = await import("bun:sqlite")
          const reader = new Database(row.target!.dbPath, { readonly: true, create: false })
          try {
            return {
              sessions: reader.query<{ count: number }, []>("SELECT count(*) AS count FROM session").get()!.count,
              messages: reader.query<{ count: number }, []>("SELECT count(*) AS count FROM session_message").get()!
                .count,
            }
          } finally {
            reader.close()
          }
        })
        const liveSessions = yield* db.all("SELECT id FROM session").pipe(Effect.orDie)
        const jobs = yield* db.all("SELECT job_id FROM import_job").pipe(Effect.orDie)
        yield* Effect.promise(() =>
          publishImportFixturePacket(path.join(root, `${input.name}.json`), {
            before,
            after,
            sourceBefore,
            sourceAfter,
            proof,
            target,
            job: ImportJob.info(row),
            liveSessions,
            jobs,
          }),
        )
        yield* Effect.promise(() => inspect.delete())
      }
    }),
  ).pipe(
    Effect.provide(importServer(path.join(root, "live.db"), "lifecycle-private-auth")),
    Effect.provide(NodeServices.layer),
  ),
  { signal: abort.signal },
).catch((error: unknown) => {
  stage(abort.signal.aborted ? "aborted" : "failed")
  if (!abort.signal.aborted) throw error
})
