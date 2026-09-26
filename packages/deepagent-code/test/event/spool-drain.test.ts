import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { EventSpool } from "@deepagent-code/core/deepagent/event-spool"
import { EventAdmission } from "@deepagent-code/core/deepagent/event-admission"
import { ConsumerReceipts } from "@deepagent-code/core/deepagent/consumer-receipts"
import { DeepAgentEventAdmissionTable } from "@deepagent-code/core/deepagent/event-admission-sql"
import { contentDigest } from "@deepagent-code/core/contract/digest"
import { decodeEventWorkEnvelope, encodeEventWorkEnvelope, eventWorkEnvelopeDigest, type EventWorkEnvelope } from "@deepagent-code/core/contract/event-envelope"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { createRuntimeFeatureRegistry } from "@deepagent-code/core/flag/runtime-features"
import {
  spoolDrainPass,
  CONSUMER_FAILURE_KIND,
  spoolAdmissionAnchor,
  spoolNackBackoffMs,
  SPOOL_DRAIN_LEASE_MS,
} from "../../src/session/v4-event-runtime"

// W5 ③ — DLQ 可见化: the C5 spool drain (v4-event-runtime) is the production consumer of
// `deepagent_event_spool`; a consumption failure must (a) nack (bounded retry → `dead` = the DLQ),
// (b) write an `event_consumer_failure` receipt (durable, admin-queriable) and (c) log. A successful
// drain commits the row `resolved` + the admission receipt `resolved`.

type Db = Database.Interface["db"]
const admissionOff = createRuntimeFeatureRegistry(undefined, {
  [EventAdmission.EVENT_V2_ADMISSION_ENV]: "false",
})

// Frozen-contract bounded work envelope (never the raw payload) — same shape the coalescing lane spools.
const envelopeFor = (eventRef: string): EventWorkEnvelope =>
  decodeEventWorkEnvelope({
    schemaVersion: "event-work.v1",
    eventRef,
    eventType: "w5.spool.test",
    objective: "do the spooled work",
    payload: { contentType: "application/json", ref: eventRef, payloadHash: "0".repeat(64) },
    verifiedFacts: [],
    requestedCapability: "deepagent.work",
    actorAndScope: { actorId: "system", workspaceId: "acme/w5-spool", securityNamespaceId: "ns-1", projectScopeKey: "psc-1" },
    trust: { level: "derived" },
    permission: { scopes: [], required: ["deepagent.work"], maxAutonomy: "medium" },
    egress: { allowedDomains: [], allowedSensitivities: [] },
    risk: "high",
    autonomyCeiling: "high",
    contextQuery: { intent: "recall" },
    budget: { maxTokens: 20_000, maxToolCalls: 12, hourTokensMax: 10_000, hourWindowMinutes: 60 },
    correlationId: "corr-w5",
    delivery: { consumerGroupId: "spool-drain", leaseToken: "t", attemptCount: 0, dedupeId: "d", exactlyOnceCursor: "c" },
  })

const failingV2Session = (calls: number[]): SessionV2.Interface =>
  ({
    get: () => Effect.fail(new Error("not found")),
    create: () => Effect.sync(() => ({}) as never),
    prompt: () =>
      Effect.sync(() => {
        calls.push(1)
      }).pipe(Effect.flatMap(() => Effect.fail(new Error("SessionV2 refused the spooled work")))),
  }) as unknown as SessionV2.Interface

const succeedingV2Session = (calls: { prompts: number; readonly withAnchor?: string[] }): SessionV2.Interface =>
  ({
    get: () => Effect.fail(new Error("not found")),
    create: () => Effect.sync(() => ({}) as never),
    prompt: (input: Parameters<SessionV2.Interface["prompt"]>[0]) =>
      Effect.sync(() => {
        calls.prompts++
        if (calls.withAnchor) calls.withAnchor.push(String(input.id))
        return { id: SessionMessage.ID.make("msg_spool_admitted") }
      }),
  }) as unknown as SessionV2.Interface

/** A succeeding SessionV2 that records the EXACT message id the adapter derived (for anchor assertions). */
const succeedingAnchorSession = (calls: Array<{ id: string }>): SessionV2.Interface =>
  ({
    get: () => Effect.fail(new Error("not found")),
    create: () => Effect.sync(() => ({}) as never),
    prompt: (input: Parameters<SessionV2.Interface["prompt"]>[0]) =>
      Effect.sync(() => {
        const id = String(input.id)
        calls.push({ id })
        return { id: SessionMessage.ID.make(id) }
      }),
  }) as unknown as SessionV2.Interface

const saved = process.env[EventAdmission.EVENT_V2_ADMISSION_ENV]

beforeAll(() => {
  process.env[EventAdmission.EVENT_V2_ADMISSION_ENV] = "true"
})
afterAll(() => {
  if (saved === undefined) delete process.env[EventAdmission.EVENT_V2_ADMISSION_ENV]
  else process.env[EventAdmission.EVENT_V2_ADMISSION_ENV] = saved
})

/** A fresh full-schema Database (Database.layerFromPath runs the migration chain incl. the event ledgers). */
const runWithDb = <A>(body: (db: Db) => Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      return yield* body(db)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )

describe("W5 DLQ visibility — spool drain failure → event_consumer_failure receipt + log", () => {
  test("a failing drain NACKS with backoff, records the failure receipt ONLY on dead, dead-letters after the bounded retry cap", async () => {
    await runWithDb((db) =>
      Effect.gen(function* () {
        const envelope = envelopeFor("event://w5-spool-fail")
        yield* EventSpool.enqueue(db, { envelope, sessionID: "ses_w5_fail", priority: "high", now: 10 })
        const recorded: number[] = []
        // W5 F4 ③ — the nack backs off exponentially; each pass must advance the clock past the backoff
        // (capacitated at SPOOL_NACK_BACKOFF_CAP_MS) before the row re-claims.
        let clock = 10
        for (let attempt = 1; attempt <= EventSpool.DEFAULT_MAX_ATTEMPTS + 1; attempt++) {
          yield* spoolDrainPass({ db, v2Session: failingV2Session(recorded), now: () => clock })
          clock += spoolNackBackoffMs(attempt) + 1000
        }
        const row = yield* EventSpool.getByRef(db, envelope.eventRef)
        expect(row?.status).toBe("dead")
        expect(row?.attempts).toBeGreaterThanOrEqual(EventSpool.DEFAULT_MAX_ATTEMPTS)
        expect(row?.lastError).toContain("SessionV2 refused the spooled work")
        // The DURABLE failure receipt (admin-queriable DLQ view) carries the reason + attempt count; W5
        // F4 ① — it is written when the nack dead-lettered the row (terminal), never on intermediate nacks.
        const receipt = yield* ConsumerReceipts.receiptFor(db, CONSUMER_FAILURE_KIND, envelope.eventRef)
        expect(receipt).toBeDefined()
        if (!receipt) return
        expect(receipt.status).toBe("dead")
        expect(receipt.lastError).toContain("SessionV2 refused the spooled work")
        expect(receipt.attempts).toBe(row!.attempts)
        // The admission receipt is honestly terminal `refused` (its effect never ran).
        const admission = yield* EventAdmission.admissionFor(db, envelope.eventRef)
        expect(admission?.status).toBe("refused")
      }),
    )
  })

  test("a later drain repairs a missing terminal receipt without retrying the dead work", async () => {
    await runWithDb((db) =>
      Effect.gen(function* () {
        const envelope = envelopeFor("event://w5-spool-crash-gap")
        yield* EventSpool.enqueue(db, { envelope, sessionID: "ses_w5_crash_gap", priority: "high", now: 10 })
        const claimed = yield* EventSpool.claimDue(db, { claimantId: "test", now: 20 })
        yield* EventSpool.nack(db, {
          eventRef: envelope.eventRef,
          claimToken: claimed.claimToken,
          now: 30,
          reason: "crashed after nack",
          maxAttempts: 1,
        })
        expect(yield* ConsumerReceipts.receiptFor(db, CONSUMER_FAILURE_KIND, envelope.eventRef)).toBeUndefined()

        const calls: number[] = []
        yield* spoolDrainPass({ db, v2Session: failingV2Session(calls), now: () => 40 })
        expect(calls).toHaveLength(0)
        const receipt = yield* ConsumerReceipts.receiptFor(db, CONSUMER_FAILURE_KIND, envelope.eventRef)
        expect(receipt).toMatchObject({ status: "dead", attempts: 1, lastError: "crashed after nack" })

        yield* spoolDrainPass({ db, v2Session: failingV2Session(calls), now: () => 50 })
        expect(calls).toHaveLength(0)
        expect(yield* ConsumerReceipts.receiptFor(db, CONSUMER_FAILURE_KIND, envelope.eventRef)).toEqual(receipt)
      }),
    )
  })

  test("an intermediate (non-dead) nack does NOT write an event_consumer_failure receipt", async () => {
    await runWithDb((db) =>
      Effect.gen(function* () {
        const envelope = envelopeFor("event://w5-spool-mid")
        yield* EventSpool.enqueue(db, { envelope, sessionID: "ses_w5_mid", priority: "high", now: 10 })
        // One failing drain: the row is nacked back to `pending` (retryable) — NOT dead yet.
        yield* spoolDrainPass({ db, v2Session: failingV2Session([]), now: () => 20_000 })
        const row = yield* EventSpool.getByRef(db, envelope.eventRef)
        expect(row?.status).toBe("pending")
        // W5 F4 ① — the spool row (attempts/last_error) is the intermediate record; no DLQ receipt yet.
        const receipt = yield* ConsumerReceipts.receiptFor(db, CONSUMER_FAILURE_KIND, envelope.eventRef)
        expect(receipt).toBeUndefined()
      }),
    )
  })

  test("W5 F4 ② — a successful drain CLEARS a stale pending failure receipt", async () => {
    await runWithDb((db) =>
      Effect.gen(function* () {
        const envelope = envelopeFor("event://w5-spool-cleared")
        yield* EventSpool.enqueue(db, { envelope, sessionID: "ses_w5_cleared", priority: "high", now: 10 })
        // Simulate the pre-F4 state: a pending failure receipt left by an earlier drain iteration.
        const seeded = yield* ConsumerReceipts.runOnce(db, {
          consumerKind: CONSUMER_FAILURE_KIND,
          sourceEventId: envelope.eventRef,
          sideEffect: Effect.fail(new Error("transient failure")),
          now: 10,
        }).pipe(Effect.match({ onSuccess: () => undefined, onFailure: () => "failed" as const }))
        expect(seeded).toBe("failed")
        expect((yield* ConsumerReceipts.receiptFor(db, CONSUMER_FAILURE_KIND, envelope.eventRef))?.status).toBe("pending")
        const calls = { prompts: 0, withAnchor: [] as string[] }
        yield* spoolDrainPass({ db, v2Session: succeedingV2Session(calls), now: () => 20_000 })
        const row = yield* EventSpool.getByRef(db, envelope.eventRef)
        expect(row?.status).toBe("resolved")
        // The consumption eventually succeeded — the stale failure receipt is gone.
        const receipt = yield* ConsumerReceipts.receiptFor(db, CONSUMER_FAILURE_KIND, envelope.eventRef)
        expect(receipt).toBeUndefined()
      }),
    )
  })

  test("a successful drain commits `resolved` (spool + admission receipts) with the deterministic anchor", async () => {
    await runWithDb((db) =>
      Effect.gen(function* () {
        const envelope = envelopeFor("event://w5-spool-ok")
        yield* EventSpool.enqueue(db, { envelope, sessionID: "ses_w5_ok", priority: "critical", now: 10 })
        const calls = { prompts: 0, withAnchor: [] as string[] }
        yield* spoolDrainPass({ db, v2Session: succeedingV2Session(calls), now: () => 20_000 })
        const row = yield* EventSpool.getByRef(db, envelope.eventRef)
        expect(row?.status).toBe("resolved")
        // One durable SessionV2 admission with the deterministic anchor (dedupe for re-drain).
        expect(calls.prompts).toBe(1)
        expect(calls.withAnchor[0]).toContain("msg_")
        const admission = yield* EventAdmission.admissionFor(db, envelope.eventRef)
        expect(admission?.status).toBe("resolved")
        // No failure receipt was written on the success path.
        const receipt = yield* ConsumerReceipts.receiptFor(db, CONSUMER_FAILURE_KIND, envelope.eventRef)
        expect(receipt).toBeUndefined()
      }),
    )
  })

  test("W5 F2 — a legacy `admitted` row re-drives anchored at the STORED message id (no second session_input)", async () => {
    await runWithDb((db) =>
      Effect.gen(function* () {
        const envelope = envelopeFor("event://w5-spool-legacy")
        yield* EventSpool.enqueue(db, { envelope, sessionID: "ses_w5_legacy", priority: "high", now: 10 })
        // Simulate a pre-W5 admission: the legacy row carries the FIRST attempt's SessionV2 anchor and
        // the effect completed there (its message id is the reconciliation key).
        yield* db
          .insert(DeepAgentEventAdmissionTable)
          .values({
            event_ref: envelope.eventRef,
            session_id: "ses_w5_legacy",
            envelope_digest: eventWorkEnvelopeDigest(envelope),
            status: "admitted" as const,
            message_id: "anchor-legacy",
            envelope_json: JSON.stringify(encodeEventWorkEnvelope(envelope)),
            admitted_at: 5,
            updated_at: 5,
          })
          .run()
        const calls: Array<{ id: string }> = []
        const v2Session = succeedingAnchorSession(calls)
        yield* spoolDrainPass({ db, v2Session, now: () => 20_000 })
        const row = yield* EventSpool.getByRef(db, envelope.eventRef)
        expect(row?.status).toBe("resolved")
        // The drain re-anchored at the ROW's stored message id (not the spool lane anchor): the adapter's
        // message id is the SessionV2 id derived from `anchor-legacy` — SessionV2 reconcile-dedupes the
        // SAME session_input this legacy row was admitted under. A second session_input is never created.
        const spoolAnchorID = `msg_${contentDigest(spoolAdmissionAnchor(envelope.eventRef, "ses_w5_legacy")).slice(0, 40)}`
        const legacyAnchorID = `msg_${contentDigest("anchor-legacy").slice(0, 40)}`
        expect(calls.length).toBe(1)
        expect(calls[0].id).toBe(legacyAnchorID)
        expect(calls[0].id).not.toBe(spoolAnchorID)
        // The durable receipt keeps the legacy anchor chain: status flips `admitted` → `resolved`.
        const admission = yield* EventAdmission.admissionFor(db, envelope.eventRef)
        expect(admission?.status).toBe("resolved")
        // The stored receipt message id is the SessionV2 id of the re-driven (stored-anchored) input.
        expect(admission?.messageID).toBe(legacyAnchorID)
        // Re-drain (the receipt is `resolved`): the adapter is NOT re-driven (exact retry) — and the spool
        // row is resolved, so the pass claims nothing. Still one durable session_input.
        yield* spoolDrainPass({ db, v2Session, now: () => 30_000 })
        expect(calls.length).toBe(1)
      }),
    )
  })

  test("W5 F5 — an interruption does not swallow: the pass exits interrupted, the claimed row is revived by lease expiry (no spurious nack)", async () => {
    await runWithDb(((db: Db) =>
      Effect.gen(function* () {
        const envelope = envelopeFor("event://w5-spool-interrupt")
        yield* EventSpool.enqueue(db, { envelope, sessionID: "ses_w5_i", priority: "critical", now: 10 })
        let clock = 1_000
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const hangingV2Session = {
          get: () => Effect.fail(new Error("not found")),
          create: () => Effect.sync(() => ({}) as never),
          prompt: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, void 0)
              yield* Deferred.await(release)
              return { id: SessionMessage.ID.make("msg_hang") }
            }),
        } as unknown as SessionV2.Interface
        const fiber = yield* spoolDrainPass({ db, v2Session: hangingV2Session, now: () => clock }).pipe(Effect.forkScoped)
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(exit._tag === "Failure" && Cause.hasInterrupts(exit.cause)).toBe(true)
        // The interrupt was not a consumption failure: NO nack happened (no attempt inflation, no DLQ
        // receipt) — the row stays claimed until its lease expires, then revives.
        const claimed = yield* EventSpool.getByRef(db, envelope.eventRef)
        expect(claimed?.status).toBe("claimed")
        expect(claimed?.attempts).toBe(0)
        const receiptForInterrupt = yield* ConsumerReceipts.receiptFor(db, CONSUMER_FAILURE_KIND, envelope.eventRef)
        expect(receiptForInterrupt).toBeUndefined()
        // Lease revival: past SPOOL_DRAIN_LEASE_MS the same row re-claims and the work completes.
        clock += SPOOL_DRAIN_LEASE_MS + 1000
        yield* Deferred.succeed(release, void 0)
        const calls = { prompts: 0, withAnchor: [] as string[] }
        yield* spoolDrainPass({ db, v2Session: succeedingV2Session(calls), now: () => clock })
        const revived = yield* EventSpool.getByRef(db, envelope.eventRef)
        expect(revived?.status).toBe("resolved")
        expect(revived?.attempts).toBe(0)
      })) as unknown as (db: Db) => Effect.Effect<void, unknown>)
  })

  test("the drain is INERT when the V2 admission switch is OFF (never dead-letters live work)", async () => {
    await runWithDb((db) =>
      Effect.gen(function* () {
        const envelope = envelopeFor("event://w5-spool-off")
        yield* EventSpool.enqueue(db, { envelope, sessionID: "ses_w5_off", priority: "high", now: 10 })
        yield* spoolDrainPass({
          db,
          v2Session: succeedingV2Session({ prompts: 0 }),
          now: () => 30_000,
          runtimeFeatures: admissionOff,
        })
        const row = yield* EventSpool.getByRef(db, envelope.eventRef)
        expect(row?.status).toBe("pending")
        expect(row?.attempts).toBe(0)
      }),
    )
  })
})
