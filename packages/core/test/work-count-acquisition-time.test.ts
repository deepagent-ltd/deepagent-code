import { tmpdir } from "node:os"
import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { sql } from "drizzle-orm"
import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "../src/database/database"
import { LocalOperator } from "../src/im/local-operator"
import { WorkRouteApproval } from "../src/session/work-route-approval"
import { WorkCountAcquisition } from "../src/session/work-count-acquisition"
import { WorkAuthorityFixture } from "./fixture/work-authority"
import { WorkRouteApprovalFixture } from "./fixture/work-route-approval"

function code<A, E>(exit: Exit.Exit<A, E>) {
  if (Exit.isSuccess(exit)) return "success"
  const value = Cause.squash(exit.cause)
  return typeof value === "object" && value !== null && "code" in value ? value.code : String(value)
}

// Source/capture are the existing controlled SQL authority fixture. Count time is the real
// default Date.now path: no now argument, mocked clock, network or production provider.
async function isolated(body: (run: <A, E>(effect: Effect.Effect<A, E, Database.Service>) => Promise<A>, owner: {
  workID: string; acquisitionID: string; expectedRevision: number; ownerToken: string; bootID: string
}, sendingAt: number) => Promise<void>, deadlineMs = 9_000) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "dac-count-time-"))
  const proof = WorkRouteApprovalFixture.authority()
  const run = <A, E>(effect: Effect.Effect<A, E, Database.Service>) => Effect.runPromise(effect.pipe(
    Effect.provide(Layer.mergeAll(WorkAuthorityFixture.database(path.join(root, "file.sqlite")), proof.route, proof.count, WorkAuthorityFixture.verifier)),
    Effect.provideService(LocalOperator.Runtime, WorkRouteApprovalFixture.runtime), Effect.scoped,
  ))
  try {
    const sending = await run(Effect.gen(function* () {
      yield* WorkRouteApprovalFixture.initialize
      const db = (yield* Database.Service).db
      const operator = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
      yield* WorkRouteApproval.approve(db, {
        capture: proof.capture({ ...WorkRouteApprovalFixture.evidence, expiresAt: Date.now() + 60_000 }),
        requestID: "approve-real-time", expectedRevision: 0, expectedOperatorRevision: 1,
      }).pipe(Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(operator)))
      const tuple = yield* WorkRouteApprovalFixture.workWith({ now: Date.now(), approvalExpiry: Date.now() + 60_000 })
      const prepared = yield* WorkCountAcquisition.prepare(db, { acquisitionID: "real-count", binding: {
        ...tuple, sealedRequestHash: WorkCountAcquisition.sealedRequestHash(tuple),
      }, ownerToken: "counter-owner", bootID: "counter-boot", deadline: Date.now() + deadlineMs })
      return yield* WorkCountAcquisition.beginSending(db, { workID: tuple.workID, acquisitionID: prepared.acquisitionID,
        expectedRevision: prepared.revision, ownerToken: prepared.ownerToken, bootID: prepared.bootID })
    }))
    if (sending.sendingAt === null) throw new Error("missing sending time")
    await body(run, { workID: sending.binding.workID, acquisitionID: sending.acquisitionID,
      expectedRevision: sending.revision, ownerToken: sending.ownerToken, bootID: sending.bootID }, sending.sendingAt)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

test("real file DB accepts a response completed before a later transaction and reopens its exact receipt", () => isolated(async (run, owner) => {
  const countedAt = Date.now()
  await Bun.sleep(12)
  const settled = await run(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    return yield* WorkCountAcquisition.settle(db, { ...owner, result: {
      responseHash: "e".repeat(64), inputTokens: 41, countedAt, expiresAt: Date.now() + 5_000,
    } })
  }))
  expect(settled.state).toBe("settled")
  expect(settled.result?.countedAt).toBe(countedAt)
  expect(settled.terminalAt!).toBeGreaterThan(countedAt)
  expect(await run(Effect.gen(function* () { return yield* WorkCountAcquisition.get((yield* Database.Service).db, owner.workID) }))).toEqual(settled)
}))

test("a response timestamp cannot revive a count deadline that expires before its transaction", () => isolated(async (run, owner) => {
  const countedAt = Date.now()
  await Bun.sleep(90)
  await run(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const outcome = yield* WorkCountAcquisition.settle(db, { ...owner, result: {
      responseHash: "e".repeat(64), inputTokens: 41, countedAt, expiresAt: Date.now() + 5000,
    } }).pipe(Effect.exit)
    expect(code(outcome)).toBe("COUNT_EXPIRED")
    expect((yield* WorkCountAcquisition.get(db, owner.workID))?.state).toBe("sending")
    expect((yield* WorkCountAcquisition.recoverExpired(db, { workID: owner.workID, expectedRevision: owner.expectedRevision })).state).toBe("unknown")
    expect(yield* db.all("SELECT count(*) count FROM work_dispatch_reservation")).toEqual([{ count: 0 }])
  }))
}, 60))

for (const mode of ["future", "pre-send", "expired", "source-revoked", "claim-changed", "owner-released", "stale-owner"] as const) {
  test(`real count completion cannot backdate current authorization: ${mode}`, () => isolated(async (run, owner, sendingAt) => {
    const countedAt = Date.now()
    await Bun.sleep(5)
    await run(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      if (mode === "source-revoked") yield* db.run("UPDATE test_work_source SET enabled=0")
      if (mode === "claim-changed") yield* db.run("UPDATE session SET execution_claim_token=8")
      if (mode === "owner-released") yield* db.run("UPDATE session_provider_owner_lease SET released_at=CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)")
      const result = yield* WorkCountAcquisition.settle(db, { ...owner,
        ownerToken: mode === "stale-owner" ? "other-owner" : owner.ownerToken,
        result: { responseHash: "e".repeat(64), inputTokens: 41,
          countedAt: mode === "future" ? Date.now() + 60_000 : mode === "pre-send" ? sendingAt - 1 : countedAt,
          expiresAt: mode === "expired" ? countedAt : Date.now() + 5_000 },
      }).pipe(Effect.exit)
      expect(code(result)).toBe(mode === "source-revoked" ? "WORK_REVOKED" : mode === "stale-owner" ? "COUNT_OWNER_CONFLICT" :
        mode === "claim-changed" || mode === "owner-released" ? "COUNT_BINDING_CONFLICT" : "COUNT_INVALID_RESPONSE")
      expect((yield* WorkCountAcquisition.get(db, owner.workID))?.state).toBe("sending")
      expect(yield* db.all("SELECT count(*) count FROM work_dispatch_reservation")).toEqual([{ count: 0 }])
      const stopped = yield* WorkCountAcquisition.stop(db, owner)
      expect(stopped.state).toBe("unknown")
    }))
    expect(await run(Effect.gen(function* () { return (yield* WorkCountAcquisition.get((yield* Database.Service).db, owner.workID))?.state }))).toBe("unknown")
  }))
}
