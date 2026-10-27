import path from "node:path"
import { appendFileSync } from "node:fs"
import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { Hash } from "@deepagent-code/core/util/hash"
import { HttpServer } from "effect/unstable/http"
import { Database } from "@deepagent-code/core/database/database"
import { ImportJob } from "@deepagent-code/core/import-job"
import { importServer, importSource } from "./import-job"
import { importFixtureSourceInventory, publishImportFixturePacket } from "../../../app/test/components/fixture/import-control"

const root = process.argv[2]!
const observations = { count: 0 }
const stage = (phase: string, facts: { activeBatch?: "prepare" | "other" | "none" } = {}) => {
  if (observations.count++ >= 128) return
  try {
    appendFileSync(
      path.join(root, "startup.jsonl"),
      JSON.stringify({ phase, at: Date.now(), elapsedMs: performance.now(), ...facts }) + "\n",
      { mode: 0o600 },
    )
  } catch {}
}
stage("fixture-module-loaded")
const abort = new AbortController()
process.once("SIGTERM", () => abort.abort())
stage("acquiring-http-and-database")
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      stage("http-and-database-acquired")
      const db = (yield* Database.Service).db
      const tables = (yield* db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").pipe(Effect.orDie))
    .filter((row) => row.name !== "import_job").map((row) => row.name).sort()
      const census = () => Effect.forEach(tables, (name) => db.all(`SELECT * FROM "${name.replaceAll('"', '""')}"`).pipe(
    Effect.orDie, Effect.map((rows) => ({ name, hash: Hash.sha256(JSON.stringify(rows.map((row) => JSON.stringify(row)).sort())) }))), { concurrency: 1 })
      const before = yield* census()
      stage("initial-database-census-complete")
      const sourcePath = yield* Effect.promise(() => importSource(root, "claude"))
      yield* Effect.promise(async () => {
    await Bun.write(path.join(sourcePath, "projects/fixture/memory/context.md"), "# Fixture memory\nKeep this private import isolated.\n")
    await Bun.write(path.join(sourcePath, "skills/gui-fixture/SKILL.md"), "# GUI fixture\nUse its complete binary assets.\n")
    await Bun.write(path.join(sourcePath, "skills/gui-fixture/assets/raw.bin"), new Uint8Array([0, 255, 128]))
  })
      const sourceBefore = yield* Effect.promise(() => importFixtureSourceInventory(sourcePath))
      stage("source-inventory-complete")
      const url = HttpServer.formatAddress((yield* HttpServer.HttpServer).address)
      yield* Effect.promise(() => publishImportFixturePacket(path.join(root, "ready.json"), { url, sourcePath }))
      stage("ready-published")
      for (;;) {
        yield* Effect.sleep("20 millis")
        if (!(yield* Effect.promise(() => Bun.file(path.join(root, "inspect.json")).exists()))) continue
        stage("inspect-seen")
        const input = yield* Effect.promise(() => Bun.file(path.join(root, "inspect.json")).json() as Promise<{ jobID: string }>)
        const row = yield* ImportJob.get(input.jobID)
        stage("original-job-observed", { activeBatch: row?.active_batch_id === "prepare" ? "prepare" : row?.active_batch_id ? "other" : "none" })
        if (!row?.target || row.state !== "completed") return yield* Effect.die("GUI did not complete its original copy job")
        const proof = yield* ImportJob.receipts({ filename: row.target.dbPath, jobID: row.job_id, sourceDigest: row.source_digest!, includeResults: true })
        stage("original-receipts-read")
        const after = yield* census()
        const sourceAfter = yield* Effect.promise(() => importFixtureSourceInventory(sourcePath))
        const binary = yield* Effect.promise(() => Bun.file(path.join(row.target!.configDir, "skills/gui-fixture/assets/raw.bin")).arrayBuffer())
        const liveSessions = yield* db.all("SELECT id FROM session").pipe(Effect.orDie)
        const jobs = yield* db.all("SELECT job_id FROM import_job").pipe(Effect.orDie)
        yield* Effect.promise(() => publishImportFixturePacket(path.join(root, "proof.json"), {
      before, after, sourceBefore, sourceAfter, proof, binary: Array.from(new Uint8Array(binary)), liveSessions, jobs,
    }))
        stage("proof-published")
        yield* Effect.never
      }
    }),
  ).pipe(
    Effect.provide(importServer(path.join(root, "live.db"), "gui-private-auth")),
    Effect.provide(NodeServices.layer),
  ),
  { signal: abort.signal },
).catch((error: unknown) => {
  stage(abort.signal.aborted ? "aborted" : "failed");
  if (!abort.signal.aborted) throw error
})
