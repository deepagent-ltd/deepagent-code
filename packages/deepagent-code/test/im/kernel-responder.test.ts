import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { IMKernelSync } from "@/im/kernel/sync"
import { testEffect } from "../lib/effect"

// The retired global mirror cannot establish a protected history/read proof.
// Current protected SDK history/replay cases live in kernel reader suites; do
// not rebuild the old raw-message responder to make its former positives pass.
const database = Database.layerFromPath(":memory:")
const it = testEffect(Layer.mergeAll(database, IMRepositoryLive.pipe(Layer.provide(database))))
describe("retired kernel mention responder", () => {
  it.effect("retired org-global provisioning is a write-free compatibility call", () => Effect.gen(function* () {
    const repo = yield* IMRepository
    const db = (yield* Database.Service).db
    const before = yield* db.all("SELECT * FROM im_groups").pipe(Effect.orDie)
    yield* IMKernelSync.provisionOrgAllGroup(repo, { uuid: "fixture-reader", name: "fixture", orgAllGroupID: "historical-org", orgID: 7 }, "fixture-workspace")
    expect(yield* db.all("SELECT * FROM im_groups").pipe(Effect.orDie)).toEqual(before)
    expect(yield* db.all("SELECT * FROM session_input").pipe(Effect.orDie)).toEqual([])
  }))
})
