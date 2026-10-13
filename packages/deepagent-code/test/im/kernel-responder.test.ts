import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { IMAgentExecution } from "@/im/im-agent-execution"
import { IMKernelSync } from "@/im/kernel/sync"
import { testEffect } from "../lib/effect"

// The retired global mirror cannot establish a protected history/read proof.
// Current protected SDK history/replay cases live in kernel reader suites; do
// not rebuild the old raw-message responder to make its former positives pass.
const database = Database.layerFromPath(":memory:")
const it = testEffect(Layer.mergeAll(database, IMRepositoryLive.pipe(Layer.provide(database))))
const originalResponder = process.env.DEEPAGENT_IM_AGENT_RESPONDER

afterEach(() => {
  if (originalResponder === undefined) delete process.env.DEEPAGENT_IM_AGENT_RESPONDER
  if (originalResponder !== undefined) process.env.DEEPAGENT_IM_AGENT_RESPONDER = originalResponder
})

describe("retired kernel mention responder", () => {
  it.effect("no environment flag restores automatic mention execution", () => Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const before = yield* db.all("SELECT (SELECT count(*) FROM session) sessions,(SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM session_v2_provider_turn_receipt) receipts").pipe(Effect.orDie)
    for (const setting of [undefined, "off", "on"]) {
      if (setting === undefined) delete process.env.DEEPAGENT_IM_AGENT_RESPONDER
      if (setting !== undefined) process.env.DEEPAGENT_IM_AGENT_RESPONDER = setting
      expect(IMAgentExecution.responderEnabled()).toBe(false)
    }
    expect(yield* db.all("SELECT (SELECT count(*) FROM session) sessions,(SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM session_v2_provider_turn_receipt) receipts").pipe(Effect.orDie)).toEqual(before)
  }))

  it.effect("retired org-global provisioning is a write-free compatibility call", () => Effect.gen(function* () {
    const repo = yield* IMRepository
    const db = (yield* Database.Service).db
    const before = yield* db.all("SELECT * FROM im_groups").pipe(Effect.orDie)
    yield* IMKernelSync.provisionOrgAllGroup(repo, { uuid: "fixture-reader", name: "fixture", orgAllGroupID: "historical-org", orgID: 7 }, "fixture-workspace")
    expect(yield* db.all("SELECT * FROM im_groups").pipe(Effect.orDie)).toEqual(before)
    expect(yield* db.all("SELECT * FROM session_input").pipe(Effect.orDie)).toEqual([])
  }))
})
