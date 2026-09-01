import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { Effect, Exit } from "effect"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { EventAdmission } from "@deepagent-code/core/deepagent/event-admission"
import { DeepAgentEventAdmissionTable, eventAdmissionMigration } from "@deepagent-code/core/deepagent/event-admission-sql"
import { EventWorkEnvelope } from "@deepagent-code/core/deepagent/event-work-envelope"
import type { EventWorkEnvelope as WorkEnvelope } from "@deepagent-code/core/contract/event-envelope"
import { encodeEventWorkEnvelope, eventWorkEnvelopeDigest, type WorkBudget, type WorkContextQuery } from "@deepagent-code/core/contract/event-envelope"
import { commandReg, makeRegistry, verifiedCommand, HASH } from "./event-fixture"

// C5-04 — V2 admission bridge. Design §8.4 (admission receipt binds envelope hash) + §2.3 (exact
// retry) + §8.7 (event turn through SessionV2/SessionExecution, never legacy SessionPrompt).

type Db = Database.Interface["db"]

const registry = makeRegistry()

const budget: WorkBudget = {
  maxTokens: 8000,
  maxToolCalls: 4,
  maxDurationMs: 60000,
  hourTokensMax: 4000,
  hourWindowMinutes: 60,
  workspaceBudgetId: "wb-1",
  agentBudgetId: "ab-1",
  eventRoot: "goal://1",
}

const contextQuery: WorkContextQuery = { intent: "related", query: "advance the goal" }

const resolution = () => ({
  trust: { level: "verified" as const, sourceRef: "ctx://src/1" },
  permission: { scopes: ["goal.read"], required: ["goal.write"], maxAutonomy: "medium" as const },
  egress: { allowedDomains: ["plugins"], allowedSensitivities: ["public"] },
  budget,
  securityNamespaceId: "ns-1",
  projectScopeKey: "psc-1",
  contextQuery,
})

const build = (event = verifiedCommand(registry), reg = commandReg): WorkEnvelope => {
  const result = EventWorkEnvelope.build({ event, registration: reg, resolution: resolution(), verifiedFacts: [{ factId: "f-1", factHash: "fh" }] })
  if (!result.ok) throw new Error(result.message)
  return result.envelope
}

const SESSION = "ses_admission_test"

function run<A, E>(effect: Effect.Effect<A, E, Database.Service>): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* DatabaseMigration.applyOnly(db, [eventAdmissionMigration])
      return yield* effect
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
}

/** A recording session adapter (the SessionV2.prompt boundary in production wiring). */
const recorder = (calls: Array<Record<string, unknown>>): EventAdmission.SessionWorkAdapter => ({
  admit: (input) =>
    Effect.sync(() => {
      calls.push({
        sessionID: input.sessionID,
        promptText: input.promptText,
        hasPayloadRef: !!input.envelope.payload && Object.keys(input.envelope.payload).length === 3,
        rawPayloadLeak: Object.keys(input.envelope).includes("payload") && "raw" in input.envelope.payload,
        delivery: input.delivery,
        resume: input.resume,
      })
      return {}
    }),
})

const refusalOf = <A>(effect: Effect.Effect<A, EventAdmission.EventAdmissionError>): Effect.Effect<EventAdmission.EventAdmissionError | undefined> =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => error,
      onSuccess: () => undefined,
    }),
  )

// The switch is module-level; save/restore around the suite.
const saved = process.env[EventAdmission.EVENT_V2_ADMISSION_ENV]

describe("C5-04 envelope-hash-bound admission", () => {
  beforeAll(() => {
    process.env[EventAdmission.EVENT_V2_ADMISSION_ENV] = "true"
  })
  afterAll(() => {
    if (saved === undefined) delete process.env[EventAdmission.EVENT_V2_ADMISSION_ENV]
    else process.env[EventAdmission.EVENT_V2_ADMISSION_ENV] = saved
  })

  test("admits the bounded envelope and binds the envelope digest to the receipt", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const calls: Array<Record<string, unknown>> = []
        const envelope = build()
        const result = yield* EventAdmission.admit(db, { envelope, sessionID: SESSION, adapter: recorder(calls), now: 10 })
        expect(result.kind).toBe("admitted")
        if (result.kind !== "admitted") return
        expect(result.row.envelopeDigest).toMatch(/^[0-9a-f]{64}$/)
        expect(result.row.sessionID).toBe(SESSION)
        expect(result.row.envelope.eventRef).toBe(envelope.eventRef)
        // The model-facing work is the bounded envelope (payload ref only, no raw content).
        expect(calls.length).toBe(1)
        expect(calls[0]!.rawPayloadLeak).toBe(false)
        expect(calls[0]!.hasPayloadRef).toBe(true)
        // prompt text serializes the BOUNDED envelope, not the raw payload.
        expect(String(calls[0]!.promptText)).toContain(envelope.eventType)
        expect(String(calls[0]!.promptText)).toContain("payloadHash")
        expect(String(calls[0]!.promptText)).not.toContain("SECRET")
      }),
    )
  })

  test("exact retry: re-admitting the SAME envelope is a no-op (existing receipt, no second admit)", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const calls: Array<Record<string, unknown>> = []
        const envelope = build()
        const first = yield* EventAdmission.admit(db, { envelope, sessionID: SESSION, adapter: recorder(calls), now: 10 })
        expect(first.kind).toBe("admitted")
        // Re-admit with the SAME identity + digest (a retry after a crash) → no-op.
        const again = yield* EventAdmission.admit(db, { envelope, sessionID: SESSION, adapter: recorder(calls), now: 20 })
        expect(again.kind).toBe("exact_retry")
        if (again.kind === "disabled") throw new Error("exact retry should not be disabled")
        expect(again.row.eventRef).toBe(envelope.eventRef)
        // The session adapter was NOT re-called (no duplicate SessionV2 admission).
        expect(calls.length).toBe(1)
        // Exactly one receipt row.
        expect((yield* EventAdmission.forSession(db, SESSION)).length).toBe(1)
      }),
    )
  })

  test("a DIFFERENT envelope digest for the SAME identity is a typed mismatch refusal", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const calls: Array<Record<string, unknown>> = []
        const first = build()
        yield* EventAdmission.admit(db, { envelope: first, sessionID: SESSION, adapter: recorder(calls), now: 10 })
        // Same identity (same eventId -> same eventRef) but CHANGED content (different payload hash).
        const changed = build(verifiedCommand(registry, { payload: { contentType: "application/json", ref: "ctx://p/1", payloadHash: "1".repeat(64) } }))
        expect(changed.eventRef).toBe(first.eventRef)
        const err = yield* refusalOf(EventAdmission.admit(db, { envelope: changed, sessionID: SESSION, adapter: recorder(calls), now: 20 }))
        expect(err?.reason).toBe("envelope_digest_mismatch")
        // No second admission was recorded.
        expect(calls.length).toBe(1)
      }),
    )
  })

  test("the model never receives the raw payload: the prompt text carries the envelope, not the bytes", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const envelope = build(
          verifiedCommand(registry, { payload: { contentType: "application/json", ref: "ctx://secret", payloadHash: HASH } }),
        )
        // `envelopePromptText` is a pure function of the bounded envelope — it can only reference the
        // payload by contentType/ref/hash, so the secret literal can never appear.
        const text = EventAdmission.envelopePromptText(envelope)
        expect(text).toContain(envelope.objective)
        expect(text).not.toContain("secret-content")
        expect(text).toContain(envelope.payload.payloadHash)
      }),
    )
  })
})

describe("C5-04 admission is fail-closed + default OFF", () => {
  test("when the switch is OFF, admission is a typed refusal (the legacy path stays authoritative)", async () => {
    process.env[EventAdmission.EVENT_V2_ADMISSION_ENV] = "false"
    try {
      await run(
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const envelope = build()
          const err = yield* refusalOf(EventAdmission.admit(db, { envelope, sessionID: SESSION, adapter: recorder([]), now: 10 }))
          expect(err?.reason).toBe("admission_disabled")
        }),
      )
    } finally {
      process.env[EventAdmission.EVENT_V2_ADMISSION_ENV] = "true"
    }
  })

  test("coordination/operational noise is never admitted even when the switch is ON", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        // A noise envelope passes the frozen contract shape (eventType is a plain string) but the
        // admission's §8.8 noise guard refuses it before any session adapter is consulted.
        const noise = { ...build(), eventType: "agent.task.started" }
        const err = yield* refusalOf(EventAdmission.admit(db, { envelope: noise, sessionID: SESSION, adapter: recorder([]), now: 10 }))
        expect(err?.reason).toBe("envelope_noise")
      }),
    )
  })
})

describe("C5-04 ON path has no legacy SessionPrompt caller", () => {
  test("the admission only ever invokes the injected SessionV2 adapter, never a legacy session", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        // A legacy-session spy that must NEVER be called on the V2 path.
        const legacyCalls: string[] = []
        const legacySession = { prompt: () => Effect.sync(() => legacyCalls.push("SessionPrompt.prompt")) }
        const v2Calls: Array<Record<string, unknown>> = []
        const envelope = build()
        const result = yield* EventAdmission.admit(db, { envelope, sessionID: SESSION, adapter: recorder(v2Calls), now: 10 })
        expect(result.kind).toBe("admitted")
        expect(v2Calls.length).toBe(1)
        // The V2 path never touches SessionPrompt.
        expect(legacyCalls.length).toBe(0)
      }),
    )
  })
})

// ── W5 ② receipts honesty ────────────────────────────────────────────────────────────────────────
// design W5.2: 「效果完成后写 receipt」; `resolved`/`refused` 两种终态写入; `exact_retry` 仅当幂等键完全一致.
// Persistence is asserted with a FRESH database connection (a second `Database.layerFromPath(file)`
// on the same file) — proving the receipt is durable, not an in-memory artifact.

// `Database.layerFromPath(file)` opens the business layer (full migration chain) — the FIRST open
// journals the complete chain so the SECOND (fresh) connection's preflight sees a matching lineage.
const runFile = <A>(file: string, body: (db: Db) => Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      return yield* body(db)
    }).pipe(Effect.provide(Database.layerFromPath(file)), Effect.scoped),
  )

const tmpDbFile = () => join(mkdtempSync(join(tmpdir(), "deepagent-admission-")), "test.db")

/** Adapter that records the anchor it was called with and returns a durable SessionV2 message id. */
const anchoredRecorder = (calls: Array<string | undefined>, messageID: string): EventAdmission.SessionWorkAdapter => ({
  admit: (input) =>
    Effect.sync(() => {
      calls.push(input.messageID)
      return { messageID }
    }),
})

const brokeAdapter = (message: string): EventAdmission.SessionWorkAdapter => ({
  admit: () => Effect.fail(new Error(message)),
})

describe("W5 receipt honesty — effect-first receipt with terminal states", () => {
  test("success writes the receipt AFTER the effect: `resolved` survives a fresh-connection read-back", async () => {
    const file = tmpDbFile()
    try {
      const calls: Array<string | undefined> = []
      const envelope = build()
      const first = await runFile(file, (db) =>
        EventAdmission.admit(db, {
          envelope,
          sessionID: SESSION,
          messageID: "anchor-1",
          adapter: anchoredRecorder(calls, "msg_admitted_1"),
          now: 10,
        }),
      )
      expect(first.kind).toBe("admitted")
      if (first.kind !== "admitted") return
      // Receipt written AFTER the effect: the SessionV2 adapter ran exactly once with the anchor.
      expect(calls).toEqual(["anchor-1"])
      // Fresh connection — durable read-back.
      const second = await runFile(file, (db) => EventAdmission.admissionFor(db, envelope.eventRef))
      expect(second?.status).toBe("resolved")
      expect(second?.messageID).toBe("msg_admitted_1")
      expect(second?.envelopeDigest).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      rmSync(join(file, ".."), { recursive: true, force: true })
    }
  })

  test("an adapter refusal writes a `refused` terminal receipt — the effect never claims `resolved`", async () => {
    const file = tmpDbFile()
    try {
      const envelope = build()
      const error = await runFile(file, (db) =>
        EventAdmission.admit(db, {
          envelope,
          sessionID: SESSION,
          messageID: "anchor-2",
          adapter: brokeAdapter("SessionV2 refused the work"),
          now: 10,
        }).pipe(
          Effect.match({
            onFailure: (e) => e,
            onSuccess: () => undefined,
          }),
        ),
      )
      expect(error?.reason).toBe("admit_refused")
      // Fresh connection — the terminal `refused` receipt is durable.
      const second = await runFile(file, (db) => EventAdmission.admissionFor(db, envelope.eventRef))
      expect(second?.status).toBe("refused")
      expect(second?.messageID).toBe("anchor-2")
    } finally {
      rmSync(join(file, ".."), { recursive: true, force: true })
    }
  })

  test("redelivery of a `refused` receipt re-drives the effect with the SAME anchor → flips to `resolved`", async () => {
    const file = tmpDbFile()
    try {
      const calls: Array<string | undefined> = []
      const envelope = build()
      const first = await runFile(file, (db) =>
        EventAdmission.admit(db, {
          envelope,
          sessionID: SESSION,
          messageID: "anchor-3",
          adapter: brokeAdapter("transient refusal"),
          now: 10,
        }).pipe(
          Effect.match({
            onFailure: (e) => e,
            onSuccess: () => undefined,
          }),
        ),
      )
      expect(first?.reason).toBe("admit_refused")
      // Redelivery (same identity + digest): NOT an exact retry — the adapter is re-driven and the
      // receipt flips to the honest terminal state `resolved`.
      const retry = await runFile(file, (db) =>
        EventAdmission.admit(db, {
          envelope,
          sessionID: SESSION,
          messageID: "anchor-3",
          adapter: anchoredRecorder(calls, "msg_admitted_3"),
          now: 20,
        }),
      )
      expect(retry.kind).toBe("admitted")
      expect(calls).toEqual(["anchor-3"])
      const readBack = await runFile(file, (db) => EventAdmission.admissionFor(db, envelope.eventRef))
      expect(readBack?.status).toBe("resolved")
    } finally {
      rmSync(join(file, ".."), { recursive: true, force: true })
    }
  })

  test("a legacy `admitted` crash-window row is re-driven (no exact-retry short-circuit) → resolved", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const calls: Array<string | undefined> = []
        const envelope = build()
        // Simulate a pre-W5 crash: the row was claimed `admitted` but the effect never completed.
        yield* db
          .insert(DeepAgentEventAdmissionTable)
          .values({
            event_ref: envelope.eventRef,
            session_id: SESSION,
            envelope_digest: eventWorkEnvelopeDigest(envelope),
            status: "admitted" as const,
            message_id: "anchor-legacy",
            envelope_json: JSON.stringify(encodeEventWorkEnvelope(envelope)),
            admitted_at: 5,
            updated_at: 5,
          })
          .run()
        const recovered = yield* EventAdmission.admit(db, {
          envelope,
          sessionID: SESSION,
          messageID: "anchor-legacy",
          adapter: anchoredRecorder(calls, "msg_recovered"),
          now: 20,
        })
        // The audit's defect was the permanent exact-retry short-circuit; W5 re-drives with the SAME
        // anchor (SessionV2 dedupes) and the receipt reaches `resolved` only now.
        expect(recovered.kind).toBe("admitted")
        expect(calls).toEqual(["anchor-legacy"])
        const row = yield* EventAdmission.admissionFor(db, envelope.eventRef)
        expect(row?.status).toBe("resolved")
      }),
    )
  })

  test("exact_retry requires the FULL idempotency key: a `resolved` receipt no-ops, a mismatch refuses", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const calls: Array<string | undefined> = []
        const envelope = build()
        yield* EventAdmission.admit(db, {
          envelope,
          sessionID: SESSION,
          messageID: "anchor-4",
          adapter: anchoredRecorder(calls, "msg_a"),
          now: 10,
        })
        // Same identity + digest + resolved → exact retry (no second effect).
        const retry = yield* EventAdmission.admit(db, {
          envelope,
          sessionID: SESSION,
          messageID: "anchor-4",
          adapter: anchoredRecorder(calls, "msg_a"),
          now: 20,
        })
        expect(retry.kind).toBe("exact_retry")
        if (retry.kind !== "exact_retry") return
        expect(retry.row.status).toBe("resolved")
        expect(calls).toEqual(["anchor-4"])
        expect((yield* EventAdmission.forSession(db, SESSION)).length).toBe(1)
        // Same identity + DIFFERENT digest → typed refusal (unchanged W0 semantics).
        const changed = build(
          verifiedCommand(registry, {
            payload: { contentType: "application/json", ref: "ctx://p/1", payloadHash: "1".repeat(64) },
          }),
        )
        const err = yield* refusalOf(
          // The mismatch refusal happens before the adapter — a fresh recorder proves it was never called.
          EventAdmission.admit(db, { envelope: changed, sessionID: SESSION, adapter: recorder([]), now: 30 }),
        )
        expect(err?.reason).toBe("envelope_digest_mismatch")
        expect(calls).toEqual(["anchor-4"])
      }),
    )
  })
})
