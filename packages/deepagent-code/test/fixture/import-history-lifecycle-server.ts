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
const observations = { count: 0, monitor: false, job: "", receipt: "", error: "", terminalError: "" }
const stage = (
  phase: string,
  facts: {
    state?: string
    hasTarget?: boolean
    hasSourceDigest?: boolean
    committedBatches?: number
    activeBatch?: "prepare" | "other" | "none"
    error_code?: string
    error_detail?: string
    available?: boolean
    count?: number
    tag?: string
    code?: string
  } = {},
) => {
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
          if (!observations.monitor) {
            observations.monitor = true
            stage("monitor-seen")
          }
          const input = yield* Effect.promise(() => monitor.json() as Promise<{ jobID: string }>)
          const row = yield* ImportJob.get(input.jobID)
          const facts = {
            state: row?.state ?? "missing",
            hasTarget: Boolean(row?.target),
            hasSourceDigest: Boolean(row?.source_digest),
            committedBatches: row?.committed_batches,
            activeBatch: row?.active_batch_id === "prepare" ? "prepare" : row?.active_batch_id ? "other" : "none",
            error_code: row?.error_code?.slice(0, 128),
            error_detail: row?.error_detail?.slice(0, 2048),
          } satisfies Parameters<typeof stage>[1]
          if (row?.state === "failed" || row?.state === "recovery_required") {
            const terminal = JSON.stringify({ jobID: row.job_id, ...facts })
            if (observations.terminalError !== terminal) {
              observations.terminalError = terminal
              console.error("IMPORT_LIFECYCLE_TERMINAL_ERROR", terminal)
            }
          }
          if (observations.job !== JSON.stringify(facts)) {
            observations.job = JSON.stringify(facts)
            stage("original-job-observed", facts)
          }
          if (
            row?.target &&
            row.source_digest &&
            !(yield* Effect.promise(() => Bun.file(path.join(root, "first-commit.json")).exists()))
          ) {
            const receipt = yield* ImportJob.receipts({
              filename: row.target.dbPath,
              jobID: row.job_id,
              sourceDigest: row.source_digest,
            }).pipe(
              Effect.tapError((error) =>
                Effect.sync(() => {
                  try {
                    const cause = error.cause
                    const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined
                    const failure = {
                      tag: "UnknownError",
                      code:
                        typeof code === "string" &&
                        [
                          "SQLITE_BUSY",
                          "SQLITE_LOCKED",
                          "SQLITE_ERROR",
                          "SQLITE_CANTOPEN",
                          "ENOENT",
                          "EACCES",
                          "EPERM",
                        ].includes(code)
                          ? code
                          : "other",
                    }
                    if (observations.error !== JSON.stringify(failure)) {
                      observations.error = JSON.stringify(failure)
                      stage("original-receipt-failed", failure)
                    }
                  } catch {}
                }),
              ),
              Effect.option,
            )
            const receiptFacts = {
              available: receipt._tag === "Some",
              count: receipt._tag === "Some" ? receipt.value.count : undefined,
            }
            if (observations.receipt !== JSON.stringify(receiptFacts)) {
              observations.receipt = JSON.stringify(receiptFacts)
              stage("original-receipt-observed", receiptFacts)
            }
            if (receipt._tag === "Some") observations.error = ""
            if (receipt._tag === "Some" && receipt.value.count > 0) {
              yield* Effect.promise(() =>
                publishImportFixturePacket(path.join(root, "first-commit.json"), {
                  jobID: row.job_id,
                  state: row.state,
                  count: receipt.value.count,
                }),
              )
              stage("first-commit-published")
            }
          }
        }
        const inspect = Bun.file(path.join(root, "inspect.json"))
        if (!(yield* Effect.promise(() => inspect.exists()))) continue
        stage("inspect-seen")
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
        stage("proof-published")
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
