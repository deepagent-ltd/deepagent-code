import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Cause, Effect, Exit } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { Database } from "../src/database/database"
import { IMTaskAuthority } from "../src/im/task-authority"
import { WorkAuthority } from "../src/session/work-authority"
import { IMTaskAuthorityFixture } from "./fixture/im-task-authority"
import { WorkAuthorityFixture } from "./fixture/work-authority"

function run<A, E>(filename: string, effect: Effect.Effect<A, E,
  Database.Service | IMTaskAuthority.Authority | WorkAuthority.Verifier>) {
  return Effect.runPromise(effect.pipe(
    Effect.provide(IMTaskAuthorityFixture.authority),
    Effect.provide(WorkAuthorityFixture.verifier),
    Effect.provide(WorkAuthorityFixture.database(filename)),
    Effect.scoped,
  ))
}

async function isolated(body: (filename: string, input: Parameters<typeof IMTaskAuthority.cancelAndControl>[1]) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "dac-im-task-cancel-"))
  try {
    const filename = path.join(root, "authority.sqlite")
    const admitted = await run(filename, Effect.gen(function* () {
      yield* IMTaskAuthorityFixture.initialize()
      const db = (yield* Database.Service).db
      const request = yield* IMTaskAuthority.propose(db, IMTaskAuthorityFixture.proposal)
      const route = yield* WorkAuthority.Verifier
      return yield* IMTaskAuthority.acceptAndReserve(db, {
        requestID: request.request_id, operationID: "accept", expectedRevision: 1, now: IMTaskAuthorityFixture.NOW,
      }).pipe(Effect.provideService(WorkAuthority.Verifier, {
        authorizeSource: IMTaskAuthority.authorizeWorkSource, resolveRoute: route.resolveRoute,
      }))
    }))
    await body(filename, {
      requestID: admitted.grant.request_id, operationID: "cancel", expectedGrantRevision: 1,
      expectedControlRevision: 1, directory: IMTaskAuthorityFixture.target.location.directory,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("offline cancellation atomically fences grant and Work, preserves unknown custody and cold exact receipt", () =>
  isolated(async (filename, input) => {
    const first = await run(filename, Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db.run("UPDATE test_task_source_proof SET active=0")
      yield* db.run("UPDATE test_task_target SET active=0")
      yield* db.run("UPDATE work_execution SET outcome='unknown'")
      const before = yield* db.all("SELECT * FROM work_execution")
      const managed = yield* IMTaskAuthority.readManagement(db, input)
      expect(managed.work?.outcome).toBe("unknown")
      expect(yield* db.all("SELECT * FROM work_execution")).toEqual(before)
      const result = yield* IMTaskAuthority.cancelAndControl(db, input)
      expect(result.grant.state).toBe("revoked")
      expect(result.grant.revision).toBe(2)
      expect(result.work?.control_state).toBe("cancelled")
      expect(result.work?.control_revision).toBe(2)
      expect(result.work?.outcome).toBe("unknown")
      expect(result.work?.admission_state).toBe("reserved")
      expect(result.work?.control_receipts).toHaveLength(1)
      return result.receipt
    }))
    await run(filename, Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const before = yield* db.all("SELECT * FROM work_execution")
      expect((yield* IMTaskAuthority.cancelAndControl(db, input)).receipt).toEqual(first)
      expect(yield* db.all("SELECT * FROM work_execution")).toEqual(before)
      expect(yield* db.all("SELECT count(*) n FROM session_input")).toEqual([{ n: 0 }])
      expect(yield* db.all("SELECT count(*) n FROM session_provider_attempt")).toEqual([{ n: 0 }])
    }))
  }))

test("stale Work cancellation rolls back the preceding grant revocation", () =>
  isolated(async (filename, input) => {
    await run(filename, Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const beforeGrant = yield* db.all("SELECT * FROM im_task_grant")
      const beforeWork = yield* db.all("SELECT * FROM work_execution")
      const exit = yield* IMTaskAuthority.cancelAndControl(db, { ...input, expectedControlRevision: 2 }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ code: "WORK_CONTROL_CONFLICT" })
      expect(yield* db.all("SELECT * FROM im_task_grant")).toEqual(beforeGrant)
      expect(yield* db.all("SELECT * FROM work_execution")).toEqual(beforeWork)
    }))
  }))

test.each(["directory", "actor", "request", "binding"] as const)("cancellation rejects changed %s before either durable fence", (mode) =>
  isolated(async (filename, input) => {
    await run(filename, Effect.gen(function* () {
      const db = (yield* Database.Service).db
      if (mode === "actor") yield* db.run(sql`UPDATE test_task_operator SET principal=${JSON.stringify({ ...IMTaskAuthorityFixture.principal, actorID: "other" })}`)
      if (mode === "request") yield* db.run("UPDATE im_task_request SET audited_text='changed'")
      if (mode === "binding") yield* db.run(sql`UPDATE work_execution SET binding_hash=${"f".repeat(64)}`)
      const beforeGrant = yield* db.all("SELECT * FROM im_task_grant")
      const beforeWork = yield* db.all("SELECT * FROM work_execution")
      const exit = yield* IMTaskAuthority.cancelAndControl(db, { ...input,
        directory: mode === "directory" ? "/tmp/other" : input.directory }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* db.all("SELECT * FROM im_task_grant")).toEqual(beforeGrant)
      expect(yield* db.all("SELECT * FROM work_execution")).toEqual(beforeWork)
    }))
  }))
