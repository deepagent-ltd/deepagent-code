import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { IMBroadcasterLive, IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { SessionV2 } from "@deepagent-code/core/session"
import { WorkAuthority } from "@deepagent-code/core/session/work-authority"
import { WorkAuthoritySchema } from "@deepagent-code/core/session/work-authority.schema"
import { WorkExecutionProfile } from "@deepagent-code/core/session/work-execution-profile"
import { WorkAuthorityFixture } from "../../../core/test/fixture/work-authority"
import { IMReplyOutbox } from "../../src/im/im-reply-outbox"
import { IMTaskResultFixture } from "./fixture/task-result"

const unused = () => Effect.die("The result-delivery oracle must not execute another installed service")
type Preparation = "current" | "unavailable" | "control_changed" | "outcome_changed"

/** Controlled local SQL authority, not a Native membership/provider execution proof. The existing
 * fixture makes the grant and terminal Work through actual stores; only the source refresh is
 * controlled here. SQLite itself proves whether each boundary is inside its transaction. */
async function isolated(
  body: (input: {
    db: Database.Interface["db"]
    original: Effect.Success<ReturnType<typeof IMTaskResultFixture.prepare>>
    item: IMReplyOutbox.ClaimedReply
    delivery: IMReplyOutbox.DeliveryDeps
    order: string[]
  }) => Effect.Effect<void, unknown>,
  preparation: Preparation = "current",
) {
  const root = await mkdtemp("/tmp/dac-im-result-source-")
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const original = yield* IMTaskResultFixture.prepare({ directory: path.join(root, "project"), outcome: "failed" })
        const db = (yield* Database.Service).db
        yield* db.run("PRAGMA foreign_keys=ON")
        yield* db.run("CREATE TABLE test_result_tx_parent(id INTEGER PRIMARY KEY)")
        yield* db.run("CREATE TABLE test_result_tx_probe(id INTEGER PRIMARY KEY REFERENCES test_result_tx_parent(id) DEFERRABLE INITIALLY DEFERRED)")
        yield* db.run(sql`DELETE FROM im_messages WHERE id=${original.messageID}`)
        yield* db.run("UPDATE im_reply_outbox SET status='pending',time_delivered=NULL,lease_owner=NULL,lease_expires_at=NULL")
        const item = yield* IMReplyOutbox.claimDueReply(db, { ownerToken: "result-source-oracle" })
        if (!item) return yield* Effect.die("Actual original outbox row could not be claimed")
        const verifier = yield* WorkAuthority.Verifier.pipe(Effect.provide(WorkAuthorityFixture.verifier))
        const order: string[] = []
        const installed: WorkExecutionProfile.Installed = {
          profile: {
            preflight: unused,
            observe: unused,
            bind: unused,
            current: unused,
            acquireCount: unused,
            prepareSource: (work) => Effect.gen(function* () {
              expect(work.work_id).toBe(original.workID)
              order.push("prepare:start")
              // BEGIN fails in an already open transaction. It changes no business rows.
              yield* db.run("BEGIN IMMEDIATE").pipe(Effect.orDie)
              yield* db.run("ROLLBACK").pipe(Effect.orDie)
              if (preparation === "unavailable")
                return yield* new WorkAuthoritySchema.Error({ code: "WORK_RECOVERY_REQUIRED", message: "Current source is unavailable" })
              if (preparation === "control_changed")
                yield* db.run("UPDATE work_execution SET control_state='revoked',control_revision=control_revision+1").pipe(Effect.orDie)
              if (preparation === "outcome_changed")
                yield* db.run("UPDATE work_execution SET outcome='succeeded'").pipe(Effect.orDie)
              order.push("prepare:end")
            }),
          },
          verifier: {
            resolveRoute: unused,
            authorizeSource: (tx, binding) => Effect.gen(function* () {
              order.push("verify:start")
              // This foreign-key violation can exist only inside a real deferred transaction.
              // In autocommit the INSERT fails before the DELETE can remove the probe.
              yield* tx.run("INSERT INTO test_result_tx_probe VALUES (1)").pipe(Effect.orDie)
              yield* tx.run("DELETE FROM test_result_tx_probe").pipe(Effect.orDie)
              const current = yield* verifier.authorizeSource(tx, binding)
              order.push("verify:end")
              return current
            }),
          },
          evidence: { resolve: unused, readCount: unused },
          approval: { captured: unused, authenticate: unused, verify: unused },
          count: { requireCapture: unused, authenticate: unused, verify: unused },
        }
        const repo = yield* IMRepository.pipe(Effect.provide(IMRepositoryLive))
        const broadcaster = yield* IMBroadcasterService.pipe(Effect.provide(IMBroadcasterLive))
        const v2Session = yield* SessionV2.Service.pipe(Effect.provide(Layer.mock(SessionV2.Service)({ message: unused })))
        yield* body({ db, original, item, order, delivery: { db, repo, broadcaster, v2Session, work: installed } })
      }).pipe(Effect.provide(WorkAuthorityFixture.database(path.join(root, "result.sqlite"))), Effect.scoped),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const unchangedDelivery = (db: Database.Interface["db"]) => Effect.gen(function* () {
  const messages = yield* db.all<Record<string, unknown>>("SELECT * FROM im_messages ORDER BY id")
  const outbox = yield* db.all<Record<string, unknown>>("SELECT * FROM im_reply_outbox ORDER BY id")
  const execution = yield* db.all<{ provider: number; dispatch: number; count: number; input: number }>(sql`
    SELECT (SELECT count(*) FROM session_provider_attempt) provider,
      (SELECT count(*) FROM work_dispatch_reservation) dispatch,
      (SELECT count(*) FROM work_count_acquisition) count,
      (SELECT count(*) FROM session_input) input`)
  return { messages, outbox, execution }
})

test("task reply refreshes the original source outside SQL before the actual source verifier transaction", () =>
  isolated(({ db, original, item, delivery, order }) => Effect.gen(function* () {
    const before = yield* unchangedDelivery(db)
    yield* IMReplyOutbox.deliverReply(delivery, item)
    expect(order).toEqual(["prepare:start", "prepare:end", "verify:start", "verify:end"])
    const after = yield* unchangedDelivery(db)
    expect(after.messages).toHaveLength(before.messages.length + 1)
    expect(after.messages.find((message) => message.id === original.messageID)).toMatchObject({
      sender_type: "agent", content: item.replyText,
    })
    expect(after.outbox).toEqual(before.outbox)
    expect(after.execution).toEqual(before.execution)
    expect(after.execution).toEqual([{ provider: 0, dispatch: 0, count: 0, input: 1 }])
    expect(yield* db.all("SELECT * FROM test_result_tx_probe")).toEqual([])
  })))

test.each(["unavailable", "control_changed", "outcome_changed"] as const)(
  "source preparation %s refuses delivery before any reply or outbox change",
  (preparation) => isolated(({ db, item, delivery, order }) => Effect.gen(function* () {
    const before = yield* unchangedDelivery(db)
    const result = yield* IMReplyOutbox.deliverReply(delivery, item).pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      const failure = Cause.squash(result.cause)
      expect(failure).toBeInstanceOf(preparation === "unavailable" ? WorkAuthoritySchema.Error : Error)
      expect(failure instanceof Error ? failure.message : "").toBe(
        preparation === "unavailable" ? "Current source is unavailable" : "Task result changed during source preparation",
      )
    }
    expect(order).toEqual(preparation === "unavailable" ? ["prepare:start"] : ["prepare:start", "prepare:end"])
    expect(yield* unchangedDelivery(db)).toEqual(before)
    expect(yield* db.all("SELECT * FROM test_result_tx_probe")).toEqual([])
  }), preparation),
)
