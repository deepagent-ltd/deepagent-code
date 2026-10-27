import { tmpdir } from "node:os"
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Scope } from "effect"
import { Database } from "../src/database/database"
import { WorkAuthority } from "../src/session/work-authority"
import { WorkStorageCleanup } from "../src/session/work-storage-cleanup"
import { WorkAuthorityFixture } from "./fixture/work-authority"

test("cold reads and copied cleanup handles cannot admit storage retirement or release a real claim", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "dac-storage-cleanup-unavailable-"))
  const filename = path.join(root, "database.sqlite")
  const binding = WorkAuthorityFixture.binding("storage-no-authority")
  const run = <A,E>(effect: Effect.Effect<A,E,Database.Service | Scope.Scope>) => Effect.runPromise(effect.pipe(
    Effect.provide(WorkAuthorityFixture.verifier), Effect.provide(WorkAuthorityFixture.database(filename)), Effect.scoped))
  const snapshot = Effect.gen(function* () {
    const db = (yield* Database.Service).db
    return { claims: yield* db.all("SELECT id,execution_claim_token FROM session"),
      inputs: yield* db.all("SELECT id,session_id,promoted_seq FROM session_input"),
      work: yield* db.all("SELECT work_id,binding_hash,control_revision,outcome FROM work_execution"),
      provider: yield* db.all("SELECT receipt_id,state FROM session_v2_provider_turn_receipt"),
      cleanup: yield* db.all("SELECT admission_id,phase,revision FROM work_storage_cleanup") }
  })
  try {
    const before = await run(Effect.gen(function* () {
      yield* WorkAuthorityFixture.initialize()
      const db = (yield* Database.Service).db
      yield* WorkAuthority.reserve(db, { binding, now: WorkAuthorityFixture.NOW })
      yield* WorkAuthorityFixture.materialize(binding)
      return yield* snapshot
    }))
    expect(before.claims).toEqual([{ id: binding.sessionID, execution_claim_token: 7 }])
    for (const cold of [false,true]) await run(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      expect(yield* WorkStorageCleanup.read(db, "original-tool-admission")).toBeUndefined()
      const requested = yield* WorkStorageCleanup.cleanup(db, { recoveryID: "copied-known-recovery", admissionID: "original-tool-admission",
        requestID: cold ? "cold" : "live", expectedCustodyRevision: 1 }).pipe(Effect.exit)
      expect(Exit.isFailure(requested)).toBe(true)
      if (Exit.isFailure(requested)) expect(Cause.squash(requested.cause)).toMatchObject({ code: "STORAGE_UNAVAILABLE" })
      const captured = yield* WorkStorageCleanup.capture(db, Object.freeze({}) as WorkStorageCleanup.Prepared).pipe(Effect.exit)
      expect(Exit.isFailure(captured)).toBe(true)
      if (Exit.isFailure(captured)) expect(Cause.squash(captured.cause)).toMatchObject({ code: "STORAGE_UNAVAILABLE" })
      expect(yield* snapshot).toEqual(before)
    }))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
}, 30000)
