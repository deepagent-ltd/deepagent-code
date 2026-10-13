import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http"
import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "@deepagent-code/core/database/database"
import { ImportJob } from "@deepagent-code/core/import-job"
import { ImportJobSchema } from "@deepagent-code/core/import-job/schema"
import { openUserGlobalStore } from "@deepagent-code/core/deepagent/durable-knowledge-store"
import { resolveConfigPath, resolveDataPath } from "@deepagent-code/core/global-path"
import { ImportFileSet } from "@/import/writer/file-set"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { runImport } from "@/import"
import { tmpdirScoped } from "../fixture/fixture"
import { importServer, importSource } from "../fixture/import-job"
import { testEffect } from "../lib/effect"

const it = testEffect(NodeServices.layer)
const post = (url: string, body?: unknown) =>
  HttpClientRequest.post(url).pipe(
    HttpClientRequest.setBody(HttpBody.text(JSON.stringify(body ?? {}), "application/json")),
    HttpClient.execute,
  )
const get = (id: string) =>
  HttpClientRequest.get(`/global/import/jobs/${id}`).pipe(
    HttpClient.execute,
    Effect.flatMap((response) => response.json),
    Effect.map((body) => body as ImportJobSchema.Info),
  )
const waitFor = (id: string, predicate: (job: ImportJobSchema.Info) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 2_000; attempt++) {
      const job = yield* get(id)
      if (predicate(job)) return job
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.die(`Import ${id} did not settle`)
  })
const wait = (id: string) => waitFor(id, (job) => ImportJobSchema.terminal(job.state))

it.live("unmanaged memory/skill writes are rejected before source or live destination IO", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const rejected = yield* Effect.tryPromise(() =>
      runImport({ source: "claude", sourcePath: path.join(root, "absent-source"), scopes: ["memory", "skill"] }),
    ).pipe(Effect.exit)
    expect(Exit.isFailure(rejected)).toBe(true)
    if (Exit.isFailure(rejected)) expect(Cause.pretty(rejected.cause)).toContain("IMPORT_DURABLE_FILE_JOB_REQUIRED")
    expect(yield* Effect.promise(() => fs.readdir(root))).toEqual([])
  }),
)
async function source(root: string) {
  const sourcePath = await importSource(root, "claude")
  await Bun.write(
    path.join(sourcePath, "projects", "fixture", "memory", "safe.md"),
    "# Preference\nPrefer deterministic isolated verification before changing a project.\n",
  )
  await Bun.write(
    path.join(sourcePath, "projects", "fixture", "memory", "review.md"),
    "# Credential procedure\nKeep the password procedure in the review queue for manual assessment.\n",
  )
  await Bun.write(
    path.join(sourcePath, "skills", "asset-fixture", "SKILL.md"),
    "# Asset fixture\nUse the packaged assets.\n",
  )
  await Bun.write(path.join(sourcePath, "skills", "asset-fixture", "scripts", "run.sh"), "#!/bin/sh\nprintf fixture\n")
  await Bun.write(
    path.join(sourcePath, "skills", "asset-fixture", "assets", "image.bin"),
    new Uint8Array([0, 255, 10, 128]),
  )
  // An unrelated source asset does not become a snapshot input.
  await Bun.write(path.join(sourcePath, "projects", "fixture", "ignored.bin"), new Uint8Array([1, 2, 3]))
  return sourcePath
}

it.live(
  "durable copy publishes governance roots and nested frozen skill assets with SQL receipts",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const sourcePath = yield* Effect.promise(() => source(root))
      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const liveSkill = path.join(resolveConfigPath(), "skills", "asset-fixture", "SKILL.md")
        yield* Effect.promise(() => Bun.write(liveSkill, "existing live skill"))
        const accepted = (yield* (yield* post("/global/import/jobs", {
          requestID: "files-complete",
          source: "claude",
          sourcePath,
          scopes: ["session", "memory", "skill"],
        })).json) as ImportJobSchema.Info
        const completed = yield* wait(accepted.id)
        expect(completed).toMatchObject({ state: "completed", scopes: ["session", "memory", "skill"],
          committedBatches: 3, committedSessions: 1, failedBatches: 0 })
        const target = completed.target!
        const proof = yield* ImportJob.receipts({
          filename: target.dbPath,
          jobID: completed.id,
          sourceDigest: completed.sourceDigest,
          includeResults: true,
        })
        expect(proof.results).toHaveLength(1)
        expect(proof.fileResults).toHaveLength(2)
        expect(completed.fileResults).toEqual(proof.fileResults)
        expect(proof.fileResults.find((result) => result.scope === "memory")).toMatchObject({
          phase: "published",
          summary: { staged: 2, approved: 1, pending: 1, writtenToInstructions: false },
        })
        const store = openUserGlobalStore(target.dataRoot)
        expect(store.listByStatus("active")).toHaveLength(1)
        expect(store.listByStatus("candidate")).toHaveLength(1)
        expect(
          yield* Effect.promise(() =>
            Bun.file(path.join(target.configDir, "skills/asset-fixture/scripts/run.sh")).text(),
          ),
        ).toContain("printf fixture")
        expect([
          ...(yield* Effect.promise(() =>
            Bun.file(path.join(target.configDir, "skills/asset-fixture/assets/image.bin")).bytes(),
          )),
        ]).toEqual([0, 255, 10, 128])
        expect(yield* Effect.promise(() => Bun.file(liveSkill).text())).toBe("existing live skill")
        expect(
          yield* Effect.promise(() => Bun.file(path.join(resolveDataPath(), "public/knowledge/docs")).exists()),
        ).toBe(false)
        expect(yield* db.all("SELECT id FROM session").pipe(Effect.orDie)).toEqual([])
        const before = yield* db.get("SELECT total_changes() AS changes").pipe(Effect.orDie)
        expect((yield* get(completed.id)).committedBatches).toBe(3)
        expect(yield* db.get("SELECT total_changes() AS changes").pipe(Effect.orDie)).toEqual(before)
        expect(
          yield* Effect.promise(() =>
            Bun.file(path.join(path.dirname(target.dataRoot), "snapshot/source/projects/fixture/ignored.bin")).exists(),
          ),
        ).toBe(false)
        const bytes = yield* Effect.promise(() =>
          fs.readFile(path.join(target.configDir, "skills/asset-fixture/assets/image.bin")),
        )
        yield* Effect.promise(() =>
          fs.writeFile(path.join(target.configDir, "skills/asset-fixture/assets/image.bin"), Buffer.from([7])),
        )
        const changed = yield* get(completed.id)
        expect(changed.state).toBe("recovery_required")
        expect(changed.fileResults).toBeUndefined()
        expect(changed.committedSessions).toBeUndefined()
        expect(yield* db.get("SELECT total_changes() AS changes").pipe(Effect.orDie)).toEqual(before)
        yield* Effect.promise(() =>
          fs.writeFile(path.join(target.configDir, "skills/asset-fixture/assets/image.bin"), bytes),
        )
        expect((yield* get(completed.id)).state).toBe("completed")
      }).pipe(Effect.provide(importServer(path.join(root, "live.db"))))
    }),
  30_000,
)

for (const corruption of ["none", "bytes", "rehashed_manifest"])
  it.live(
    `real receipt failure after rename: cold cancel checks ${corruption}`,
    () =>
      Effect.gen(function* () {
        const corrupt = corruption !== "none"
        const root = yield* tmpdirScoped()
        const sourcePath = yield* Effect.promise(() => source(root))
        const failed = yield* Effect.gen(function* () {
          const db = (yield* Database.Service).db
          // The actual verified backup copies this trigger to the actual destination DB.
          yield* db
            .run(
              "CREATE TRIGGER import_file_fail_receipt BEFORE INSERT ON import_batch_receipt WHEN json_extract(NEW.result,'$.scope') = 'skill' BEGIN SELECT RAISE(ABORT, 'real destination receipt failure'); END",
            )
            .pipe(Effect.orDie)
          const accepted = (yield* (yield* post("/global/import/jobs", {
            requestID: `files-unknown-${corruption}`,
            source: "claude",
            sourcePath,
            scopes: ["memory", "skill"],
          })).json) as ImportJobSchema.Info
          const unknown = yield* wait(accepted.id)
          expect(unknown.state).toBe("recovery_required")
          expect(unknown.activeBatchID).toMatch(/^file_[a-f0-9]{64}:[a-f0-9]{64}$/)
          expect(unknown.stopConfirmedAt).toBeUndefined()
          expect(unknown.committedBatches).toBe(1)
          expect(unknown.error?.code).toBe("IMPORT_FILE_PUBLICATION_UNKNOWN")
          return unknown
        }).pipe(Effect.provide(importServer(path.join(root, "live.db"))))
        const filename = path.join(failed.target!.configDir, "skills/asset-fixture/SKILL.md")
        const original = yield* Effect.promise(() => fs.stat(path.dirname(filename)))
        yield* ImportJob.withDestinationFence(failed.target!.dbPath, async (database) => {
          database.exec("DROP TRIGGER import_file_fail_receipt")
        })
        if (!corrupt) {
          const failedCommit = yield* ImportJob.withDestinationFence(failed.target!.dbPath, async (database) => {
            const bound = failed.activeBatchID!.split(":")
            await ImportFileSet.reconcile(
              failed.target!,
              failed.id,
              bound[0]!,
              failed.sourceDigest!,
              bound[1]!,
              database,
            )
            // A real unfinished write statement makes SQLite reject COMMIT after the
            // real reconciliation INSERT. No callback or receipt operation is mocked.
            database.exec("CREATE TABLE import_pending_commit(value INTEGER)")
            database.query("INSERT INTO import_pending_commit VALUES(1),(2) RETURNING value").iterate().next()
          }).pipe(Effect.exit)
          expect(Exit.isFailure(failedCommit)).toBe(true)
          expect((yield* ImportJob.receipts({ filename: failed.target!.dbPath, jobID: failed.id })).count).toBe(1)
        }
        if (corrupt) yield* Effect.promise(() => fs.appendFile(filename, "changed after publication"))
        if (corruption === "rehashed_manifest")
          yield* Effect.promise(async () => {
            const manifestPath = path.join(
              path.dirname(failed.target!.dataRoot),
              "file-batches",
              failed.activeBatchID!.split(":")[0]!,
              "manifest.json",
            )
            const manifest = (await Bun.file(manifestPath).json()) as {
              result: ImportJobSchema.FileSetResult
              files: { relative: string; bytes: number; sha256: string }[]
            }
            const changed = await fs.readFile(filename)
            const file = manifest.files.find((file) => file.relative === "SKILL.md")!
            file.bytes = changed.length
            file.sha256 = Hash.sha256(changed)
            const forged = {
              ...manifest,
              result: {
                ...manifest.result,
                bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
                manifestHash: "0".repeat(64),
              },
            }
            await fs.writeFile(
              manifestPath,
              CanonicalJson.stringify({
                ...forged,
                result: { ...forged.result, manifestHash: Hash.sha256(CanonicalJson.stringify(forged)) },
              }),
            )
          })
        // A new HTTP runtime cannot adopt the stopped driver or silently repair its receipt.
        yield* Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const before = yield* db.get("SELECT total_changes() AS changes").pipe(Effect.orDie)
          expect((yield* get(failed.id)).state).toBe("recovery_required")
          expect((yield* ImportJob.receipts({ filename: failed.target!.dbPath, jobID: failed.id })).count).toBe(1)
          expect(yield* db.get("SELECT total_changes() AS changes").pipe(Effect.orDie)).toEqual(before)
          const stopped = (yield* (yield* post(`/global/import/jobs/${failed.id}/cancel`)).json) as ImportJobSchema.Info
          expect(stopped.state).toBe(corrupt ? "recovery_required" : "cancelled_partial")
          expect(stopped.committedBatches).toBe(corrupt ? 1 : 2)
          if (corrupt) expect(stopped.stopConfirmedAt).toBeUndefined()
          if (!corrupt) expect(stopped.stopConfirmedAt).toBeGreaterThan(0)
          const actual = yield* Effect.promise(() => fs.stat(path.dirname(filename)))
          expect([actual.dev, actual.ino]).toEqual([original.dev, original.ino])
          expect(yield* Effect.promise(() => Bun.file(filename).exists())).toBe(true)
          if (!corrupt) {
            const proof = yield* ImportJob.receipts({
              filename: failed.target!.dbPath,
              jobID: failed.id,
              sourceDigest: failed.sourceDigest,
              includeResults: true,
            })
            yield* Effect.promise(() =>
              ImportFileSet.verifyReceipts(failed.target!, failed.id, failed.sourceDigest!, proof.fileResults),
            )
            expect(proof.fileResults).toHaveLength(2)
            expect((yield* get(failed.id)).state).toBe("cancelled_partial")
          }
        }).pipe(Effect.provide(importServer(path.join(root, "live.db"))))
      }),
    30_000,
  )

for (const partial of [false, true])
  it.live(
    `actual cancellation ${partial ? "after a file receipt keeps the published prefix" : "during staging publishes zero files"}`,
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        const sourcePath = yield* Effect.promise(() => importSource(root, "claude"))
        yield* Effect.promise(async () => {
          for (let index = 0; index < (partial ? 50 : 1); index++) {
            const directory = path.join(sourcePath, "skills", `cancel-${String(index).padStart(3, "0")}`)
            await Bun.write(path.join(directory, "SKILL.md"), "# Cancel fixture\nUse the immutable asset set.\n")
            if (!partial)
              for (let asset = 0; asset < 300; asset++)
                await Bun.write(path.join(directory, "assets", `${asset}.txt`), `asset ${asset}`)
          }
        })
        yield* Effect.gen(function* () {
          const accepted = (yield* (yield* post("/global/import/jobs", {
            requestID: `cancel-files-${partial}`,
            source: "claude",
            sourcePath,
            scopes: ["skill"],
          })).json) as ImportJobSchema.Info
          const writing = yield* waitFor(accepted.id, (job) =>
            partial
              ? job.committedBatches > 0 || ImportJobSchema.terminal(job.state)
              : /^file_[a-f0-9]{64}$/.test(job.activeBatchID ?? "") || ImportJobSchema.terminal(job.state),
          )
          expect(writing.state).toBe("running")
          const acknowledgement = (yield* (yield* post(`/global/import/jobs/${writing.id}/cancel`))
            .json) as ImportJobSchema.Info
          expect(["cancel_requested", "cancelled", "cancelled_partial"]).toContain(acknowledgement.state)
          const stopped = yield* wait(writing.id)
          expect(stopped.state).toBe(partial ? "cancelled_partial" : "cancelled")
          expect(stopped.stopConfirmedAt).toBeGreaterThan(0)
          if (partial) expect(stopped.committedBatches).toBeGreaterThanOrEqual(writing.committedBatches)
          if (!partial) expect(stopped.committedBatches).toBe(0)
          if (partial) expect(stopped.committedBatches).toBeLessThan(50)
          const proof = yield* ImportJob.receipts({
            filename: stopped.target!.dbPath,
            jobID: stopped.id,
            sourceDigest: stopped.sourceDigest,
            includeResults: true,
          })
          expect(proof.count).toBe(stopped.committedBatches)
          yield* Effect.promise(() =>
            ImportFileSet.verifyReceipts(stopped.target!, stopped.id, stopped.sourceDigest!, proof.fileResults),
          )
          if (!partial)
            expect(
              yield* Effect.promise(() =>
                Bun.file(path.join(stopped.target!.configDir, "skills/cancel-000/SKILL.md")).exists(),
              ),
            ).toBe(false)
        }).pipe(Effect.provide(importServer(path.join(root, "live.db"))))
      }),
    30_000,
  )

it.live(
  "one oversized memory governance root fails completely without publishing a truncated prefix",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const sourcePath = yield* Effect.promise(() => importSource(root, "codex"))
      const body = `start${"\t".repeat(9_000_000)}finish`
      yield* Effect.promise(() => Bun.write(path.join(sourcePath, "memories/large.md"), body))
      yield* Effect.gen(function* () {
        const accepted = (yield* (yield* post("/global/import/jobs", {
          requestID: "memory-whole-root-budget",
          source: "codex",
          sourcePath,
          scopes: ["memory"],
        })).json) as ImportJobSchema.Info
        const failed = yield* wait(accepted.id)
        expect(failed).toMatchObject({ state: "failed", committedBatches: 0 })
        expect(failed.error?.code).toBe("IMPORT_FILE_BUDGET_EXCEEDED")
        expect((yield* ImportJob.receipts({ filename: failed.target!.dbPath, jobID: failed.id })).count).toBe(0)
        expect(
          yield* Effect.promise(() => Bun.file(path.join(failed.target!.dataRoot, "public/knowledge/docs")).exists()),
        ).toBe(false)
        expect(
          yield* Effect.promise(() =>
            Bun.file(path.join(path.dirname(failed.target!.dataRoot), "snapshot/source/memories/large.md")).text(),
          ),
        ).toBe(body)
      }).pipe(Effect.provide(importServer(path.join(root, "live.db"))))
    }),
  30_000,
)
