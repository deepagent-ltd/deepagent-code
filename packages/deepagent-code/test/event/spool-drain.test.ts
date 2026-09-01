import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { EventSpool } from "@deepagent-code/core/deepagent/event-spool"
import { EventAdmission } from "@deepagent-code/core/deepagent/event-admission"
import { ConsumerReceipts } from "@deepagent-code/core/deepagent/consumer-receipts"
import { decodeEventWorkEnvelope, type EventWorkEnvelope } from "@deepagent-code/core/contract/event-envelope"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { spoolDrainPass, CONSUMER_FAILURE_KIND } from "../../src/session/v4-event-runtime"

// W5 ③ — DLQ 可见化: the C5 spool drain (v4-event-runtime) is the production consumer of
// `deepagent_event_spool`; a consumption failure must (a) nack (bounded retry → `dead` = the DLQ),
// (b) write an `event_consumer_failure` receipt (durable, admin-queriable) and (c) log. A successful
// drain commits the row `resolved` + the admission receipt `resolved`.

type Db = Database.Interface["db"]

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
  test("a failing drain NACKS, records the failure receipt and dead-letters after the bounded retry cap", async () => {
    await runWithDb((db) =>
      Effect.gen(function* () {
        const envelope = envelopeFor("event://w5-spool-fail")
        yield* EventSpool.enqueue(db, { envelope, sessionID: "ses_w5_fail", priority: "high", now: 10 })
        const recorded: number[] = []
        // Drain the spool until the row exhausts its bounded retries → DLQ (`dead`).
        for (let attempt = 1; attempt <= EventSpool.DEFAULT_MAX_ATTEMPTS + 1; attempt++) {
          yield* spoolDrainPass({ db, v2Session: failingV2Session(recorded), now: () => attempt * 1000 + 10 })
        }
        const row = yield* EventSpool.getByRef(db, envelope.eventRef)
        expect(row?.status).toBe("dead")
        expect(row?.attempts).toBeGreaterThanOrEqual(EventSpool.DEFAULT_MAX_ATTEMPTS)
        expect(row?.lastError).toContain("SessionV2 refused the spooled work")
        // The DURABLE failure receipt (admin-queriable DLQ view) carries the reason + attempt count.
        const receipt = yield* ConsumerReceipts.receiptFor(db, CONSUMER_FAILURE_KIND, envelope.eventRef)
        expect(receipt).toBeDefined()
        if (!receipt) return
        expect(receipt.status).toBe("pending")
        expect(receipt.lastError).toContain("SessionV2 refused the spooled work")
        expect(receipt.attempts).toBeGreaterThanOrEqual(EventSpool.DEFAULT_MAX_ATTEMPTS)
        // The admission receipt is honestly terminal `refused` (its effect never ran).
        const admission = yield* EventAdmission.admissionFor(db, envelope.eventRef)
        expect(admission?.status).toBe("refused")
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

  test("the drain is INERT when the V2 admission switch is OFF (never dead-letters live work)", async () => {
    const was = process.env[EventAdmission.EVENT_V2_ADMISSION_ENV]
    process.env[EventAdmission.EVENT_V2_ADMISSION_ENV] = "false"
    try {
      await runWithDb((db) =>
        Effect.gen(function* () {
          const envelope = envelopeFor("event://w5-spool-off")
          yield* EventSpool.enqueue(db, { envelope, sessionID: "ses_w5_off", priority: "high", now: 10 })
          yield* spoolDrainPass({ db, v2Session: succeedingV2Session({ prompts: 0 }), now: () => 30_000 })
          const row = yield* EventSpool.getByRef(db, envelope.eventRef)
          expect(row?.status).toBe("pending")
          expect(row?.attempts).toBe(0)
        }),
      )
    } finally {
      if (was === undefined) delete process.env[EventAdmission.EVENT_V2_ADMISSION_ENV]
      else process.env[EventAdmission.EVENT_V2_ADMISSION_ENV] = was
    }
  })
})
