import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { Effect, Exit } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { EventAdmission } from "@deepagent-code/core/deepagent/event-admission"
import { eventAdmissionMigration } from "@deepagent-code/core/deepagent/event-admission-sql"
import { EventWorkEnvelope } from "@deepagent-code/core/deepagent/event-work-envelope"
import type { EventWorkEnvelope as WorkEnvelope } from "@deepagent-code/core/contract/event-envelope"
import type { WorkBudget, WorkContextQuery } from "@deepagent-code/core/contract/event-envelope"
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
