import { tmpdir } from "node:os"
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { Database } from "../src/database/database"
import { WorkAuthority } from "../src/session/work-authority"
import { WorkKnownRecovery } from "../src/session/work-known-recovery"
import { WorkKnownRecoverySchema } from "../src/session/work-known-recovery.schema"
import { SessionRunCoordinator } from "../src/session/run-coordinator"
import { WorkAuthorityFixture } from "./fixture/work-authority"

// This verifies the actual default-unavailable store boundary with the formal registry and a
// retained real Session claim. Native authorization/known result success is the signed CLI test.
test("uninstalled known-recovery authority cannot release a real Work claim or record a resume, including after reopen", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "dac-known-recovery-store-"))
  const filename = path.join(root, "work.sqlite")
  const binding = WorkAuthorityFixture.binding("known-recovery-unavailable")
  const run = <A, E>(effect: Effect.Effect<A, E, Database.Service | Scope.Scope>) => Effect.runPromise(effect.pipe(
    Effect.provide(WorkAuthorityFixture.verifier), Effect.provide(WorkAuthorityFixture.database(filename)), Effect.scoped))
  const snapshot = Effect.gen(function* () {
    const db = (yield* Database.Service).db
    return { session: yield* db.all("SELECT id,execution_claim_token FROM session"),
      work: yield* db.all("SELECT * FROM work_execution"), inputs: yield* db.all("SELECT * FROM session_input"),
      providers: yield* db.all("SELECT * FROM session_v2_provider_turn_receipt"),
      recoveries: yield* db.all("SELECT * FROM work_known_recovery"),
      resumes: yield* db.all("SELECT * FROM work_known_recovery_resume") }
  })
  try {
    const before = await run(Effect.gen(function* () {
      yield* WorkAuthorityFixture.initialize()
      const db = (yield* Database.Service).db
      yield* WorkAuthority.reserve(db, { binding, now: WorkAuthorityFixture.NOW })
      yield* WorkAuthorityFixture.materialize(binding)
      return yield* snapshot
    }))
    expect(before.session).toEqual([{ id: binding.sessionID, execution_claim_token: 7 }])
    for (let cold = 0; cold < 2; cold++) await run(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const recovery = yield* WorkKnownRecovery.recover(db, { workID: binding.workID, sessionID: binding.sessionID,
        requestID: "same-command", expectedClaimToken: 7, expectedControlRevision: 1, action: "recover_only" }).pipe(Effect.exit)
      expect(Exit.isFailure(recovery)).toBe(true)
      if (Exit.isFailure(recovery)) expect(Cause.squash(recovery.cause)).toMatchObject({ code: "RECOVERY_UNAVAILABLE" })
      const resume = yield* WorkKnownRecovery.recordResume(db, { recoveryID: "untrusted-copy", requestID: "resume",
        expectedControlRevision: 1 }).pipe(Effect.exit)
      expect(Exit.isFailure(resume)).toBe(true)
      if (Exit.isFailure(resume)) expect(Cause.squash(resume.cause)).toMatchObject({ code: "RECOVERY_UNAVAILABLE" })
      expect(yield* snapshot).toEqual(before)
    }))
    await run(Effect.gen(function* () {
      const invalid = yield* WorkKnownRecovery.recover((yield* Database.Service).db, { workID: binding.workID,
        sessionID: binding.sessionID, requestID: "unchanged", expectedClaimToken: 1.5,
        expectedControlRevision: 1, action: "recover_only" }).pipe(Effect.exit)
      expect(Exit.isFailure(invalid)).toBe(true)
      if (Exit.isFailure(invalid)) expect(Cause.squash(invalid.cause)).toBeInstanceOf(WorkKnownRecoverySchema.Error)
      if (Exit.isFailure(invalid)) expect(Cause.squash(invalid.cause)).toMatchObject({ code: "RECOVERY_INVALID_REQUEST" })
      expect(yield* snapshot).toEqual(before)
    }))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
}, 30_000)

// Public JSON receipts remain observations, even if they copy every known field.
test("copied or cold continuation receipts never execute a supplied effect", async () => {
  let calls = 0
  const base: WorkKnownRecoverySchema.ResumeReceipt = { recoveryID: "cold-recovery", workID: "work", sessionID: "session",
    requestID: "explicit", controlRevision: 1, createdAt: 1, replayed: false, continuation: "recorded" }
  for (const receipt of [base, { ...base }, { ...base, replayed: true }]) {
    const result = await Effect.runPromise(WorkKnownRecovery.withContinuation(receipt, Effect.sync(() => { calls++ })).pipe(Effect.exit))
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toMatchObject({ code: "RECOVERY_UNAVAILABLE" })
  }
  expect(calls).toBe(0)
})

// This exercises the real captured FiberSet runtime rather than pretending a caller Reference
// automatically reaches Started. The signed CLI case supplies the actual private Work witness.
test("coordinator carries only its trusted first-run scope across lifecycle, never wake or a busy join", async () => {
  const Current = Context.Reference<string>("test/known-continuation", { defaultValue: () => "root" })
  const observed: string[] = []
  let captures = 0
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    const coordinator = yield* SessionRunCoordinator.make({
      captureRunScope: () => Effect.gen(function* () {
        captures++
        const value = yield* Current
        return (effect: Effect.Effect<void>) => effect.pipe(Effect.provideService(Current, value))
      }),
      started: (key: string) => Current.pipe(Effect.tap((value) => Effect.sync(() => observed.push(`${key}/start/${value}`))), Effect.asVoid),
      drain: (key: string) => Effect.gen(function* () {
        observed.push(`${key}/drain/${yield* Current}`)
        if (key === "owned") { yield* Deferred.succeed(entered, undefined); yield* Deferred.await(finish) }
      }),
      settled: (key) => Current.pipe(Effect.tap((value) => Effect.sync(() => observed.push(`${key}/settled/${value}`))), Effect.asVoid),
    })
    const first = yield* coordinator.run("owned").pipe(Effect.provideService(Current, "first"), Effect.forkChild)
    yield* Deferred.await(entered)
    const joined = yield* coordinator.run("owned").pipe(Effect.provideService(Current, "foreign"), Effect.forkChild)
    yield* Effect.yieldNow
    expect(captures).toBe(1)
    yield* Deferred.succeed(finish, undefined)
    yield* Fiber.join(first)
    yield* Fiber.join(joined)
    yield* coordinator.wake("advisory").pipe(Effect.provideService(Current, "must-not-capture"))
    yield* coordinator.awaitIdle("advisory")
    expect(captures).toBe(1)
    expect(observed).toEqual(["owned/start/first", "owned/drain/first", "owned/settled/first",
      "advisory/start/root", "advisory/drain/root", "advisory/settled/root"])
  })))
})
