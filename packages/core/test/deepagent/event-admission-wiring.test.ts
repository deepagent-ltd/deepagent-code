import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { Effect } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { EventAdmission } from "@deepagent-code/core/deepagent/event-admission"
import { EventAdmissionWiring } from "@deepagent-code/core/deepagent/event-admission-wiring"
import { eventAdmissionMigration } from "@deepagent-code/core/deepagent/event-admission-sql"
import type { RegisteredEventEnvelope } from "@deepagent-code/core/deepagent/event-registry"
import { assertPublishable } from "@deepagent-code/core/deepagent/event-registry"
import { decodeEventEnvelope } from "@deepagent-code/core/contract/event-envelope"
import { commandReg, makeRegistry, verifiedCommand, commandEnvelope, HASH } from "./event-fixture"

// C5-04 — the event→envelope→admit production wiring (the mapping E4a deferred). Design §8.4 (§8.4 maps
// the registry-validated event + registration + scope to bounded V2 admission), §8.7 (SessionV2 turn),
// §8.8 (bounded, anti-noise, over-budget refusal).

type Db = Database.Interface["db"]

const registry = makeRegistry()
const SESSION = "ses_wiring_test"
const saved = process.env[EventAdmission.EVENT_V2_ADMISSION_ENV]

const verifiedScope = (
  over?: Partial<EventAdmissionWiring.AdmissionScope>,
): EventAdmissionWiring.AdmissionScope => ({
  workspaceId: "ws-1",
  securityNamespaceId: "ns-1",
  projectScopeKey: "psc-1",
  principal: "system",
  sessionID: SESSION,
  verifiedSource: { sourceRef: "ctx://src/1" },
  ...over,
})

const resolve = (
  event: RegisteredEventEnvelope,
  scope?: EventAdmissionWiring.AdmissionScope,
): EventAdmissionWiring.AdmissionResolution =>
  EventAdmissionWiring.resolveAdmissionInput(event, commandReg, scope ?? verifiedScope())

function run<A, E>(effect: Effect.Effect<A, E, Database.Service>): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* DatabaseMigration.applyOnly(db, [eventAdmissionMigration])
      return yield* effect
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
}

/** A recording SessionV2 adapter (the `SessionV2.prompt` boundary in production wiring). */
const recorder = (calls: Array<Record<string, unknown>>): EventAdmission.SessionWorkAdapter => ({
  admit: (input) =>
    Effect.sync(() => {
      calls.push({
        sessionID: input.sessionID,
        promptText: input.promptText,
        messageID: input.messageID,
        delivery: input.delivery,
        resume: input.resume,
        hasPayloadRef: !!input.envelope.payload && Object.keys(input.envelope.payload).length === 3,
        rawPayloadLeak: Object.keys(input.envelope).includes("payload") && "raw" in input.envelope.payload,
      })
      return { messageID: input.messageID }
    }),
})

const wiringFailureOf = <A>(
  effect: Effect.Effect<A, EventAdmissionWiring.EventAdmissionWiringError | EventAdmission.EventAdmissionError>,
): Effect.Effect<EventAdmissionWiring.EventAdmissionWiringError | EventAdmission.EventAdmissionError | undefined> =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => error,
      onSuccess: () => undefined,
    }),
  )

describe("C5-04 event→envelope→admit wiring", () => {
  beforeAll(() => {
    process.env[EventAdmission.EVENT_V2_ADMISSION_ENV] = "true"
  })
  afterAll(() => {
    if (saved === undefined) delete process.env[EventAdmission.EVENT_V2_ADMISSION_ENV]
    else process.env[EventAdmission.EVENT_V2_ADMISSION_ENV] = saved
  })

  test("verified trust path: a registry-verified source resolves trust `verified` with its sourceRef", () => {
    const r = resolve(verifiedCommand(registry))
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error(r.message)
    expect(r.envelope.trust.level).toBe("verified")
    expect(r.envelope.trust.sourceRef).toBe("ctx://src/1")
    expect(r.envelope.eventRef).toBe("event://e-1")
    expect(r.envelope.objective).toBe("advance the goal")
    // required permission is derived from the registration's requested capability.
    expect(r.envelope.permission.required).toEqual(["deepagent.goal.advance"])
    // egress default is fail-closed empty (the registration exposes no domains).
    expect(r.envelope.egress).toEqual({ allowedDomains: [], allowedSensitivities: [] })
    // budget is the frozen default, bound to the event root for per-root accounting.
    expect(r.envelope.budget.maxTokens).toBe(EventAdmissionWiring.DEFAULT_WORK_BUDGET.maxTokens)
    expect(r.envelope.budget.eventRoot).toBe("ag-1")
    expect(r.envelope.delivery.dedupeId).toBe("idem-1")
  })

  test("admitWork admits the bounded envelope (payload ref only, never the raw bytes)", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const calls: Array<Record<string, unknown>> = []
        const result = yield* EventAdmissionWiring.admitWork(db, {
          event: verifiedCommand(registry),
          registration: commandReg,
          scope: verifiedScope(),
          adapter: recorder(calls),
          now: 10,
        })
        expect(result.kind).toBe("admitted")
        if (result.kind !== "admitted") return
        expect(result.row.sessionID).toBe(SESSION)
        expect(result.row.envelope.eventRef).toBe("event://e-1")
        expect(result.row.envelopeDigest).toMatch(/^[0-9a-f]{64}$/)
        expect(calls.length).toBe(1)
        expect(calls[0]!.rawPayloadLeak).toBe(false)
        expect(calls[0]!.hasPayloadRef).toBe(true)
        expect(calls[0]!.delivery).toBe("steer")
        // the model-facing prompt is the BOUNDED envelope, never the raw payload bytes.
        expect(String(calls[0]!.promptText)).toContain("advance the goal")
        expect(String(calls[0]!.promptText)).toContain("payloadHash")
        expect(String(calls[0]!.promptText)).not.toContain("SECRET")
      }),
    )
  })

  test("derived-authorized path: an authorized router trigger resolves trust `derived` (no sourceRef)", () => {
    const scope = verifiedScope({ verifiedSource: undefined, authorizedTrigger: true })
    const r = resolve(verifiedCommand(registry), scope)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error(r.message)
    expect(r.envelope.trust.level).toBe("derived")
    expect(r.envelope.trust.sourceRef).toBeUndefined()
  })

  test("declared scopes flow into permission.scopes (registration required + declared scopes)", () => {
    // The fixture hardcodes `command`; build an event that declares `command.requirements`.
    const declared = assertPublishable(
      registry,
      decodeEventEnvelope({
        ...(commandEnvelope() as unknown as Record<string, unknown>),
        command: { action: "advance", targetRef: "goal://1", requirements: ["goal.read"] },
      }),
    )
    const scope = verifiedScope({ declared: { scopes: ["goal.write"] } })
    const r = resolve(declared, scope)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error(r.message)
    expect(r.envelope.permission.scopes).toContain("goal.read") // event's declared requirement
    expect(r.envelope.permission.scopes).toContain("goal.write") // caller's declared scope
  })

  test("unverified trust with no sourceRef is refused (unverified_trust_refused)", () => {
    const scope = verifiedScope({ verifiedSource: undefined })
    const r = resolve(verifiedCommand(registry), scope)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("expected refusal")
    expect(r.reason).toBe("unverified_trust_refused")
  })

  test("an unbounded payload is refused (never trusted for authority)", () => {
    const raw = commandEnvelope()
    const leak = { ...(raw as unknown as Record<string, unknown>), payload: { contentType: "application/json", ref: "ctx://p/1", payloadHash: HASH, raw: "SECRET" } }
    const r = resolve(leak as unknown as RegisteredEventEnvelope)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("expected refusal")
    expect(r.reason).toBe("unbounded_payload")
  })

  test("an over-budget declared intent is refused (over_budget)", () => {
    const over = verifiedScope({ declared: { maxTokens: EventAdmissionWiring.DEFAULT_WORK_BUDGET.maxTokens + 1 } })
    const r = resolve(verifiedCommand(registry), over)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("expected refusal")
    expect(r.reason).toBe("over_budget")
  })

  test("the messageID is deterministic from the event id + target session", () => {
    const a = resolve(verifiedCommand(registry))
    const b = resolve(verifiedCommand(registry))
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (!a.ok || !b.ok) throw new Error("expected ok")
    expect(a.messageID).toBe(`event-admission:e-1:${SESSION}`)
    expect(a.messageID).toBe(b.messageID)
  })

  test("exact retry: re-admitting the SAME event+session is a no-op (existing receipt, adapter called once)", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const calls: Array<Record<string, unknown>> = []
        const input = {
          event: verifiedCommand(registry),
          registration: commandReg,
          scope: verifiedScope(),
          adapter: recorder(calls),
          now: 10,
        }
        const first = yield* EventAdmissionWiring.admitWork(db, input)
        expect(first.kind).toBe("admitted")
        const again = yield* EventAdmissionWiring.admitWork(db, { ...input, now: 20 })
        expect(again.kind).toBe("exact_retry")
        if (again.kind === "disabled") throw new Error("exact retry should not be disabled")
        expect(again.row.eventRef).toBe("event://e-1")
        // no duplicate SessionV2 admission + exactly one receipt row.
        expect(calls.length).toBe(1)
        expect((yield* EventAdmission.forSession(db, SESSION)).length).toBe(1)
      }),
    )
  })

  test("coordination/operational noise is refused (never admitted, §8.8)", () => {
    const noise = commandEnvelope({ eventType: "agent.task.started" })
    const r = resolve(noise as unknown as RegisteredEventEnvelope)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("expected refusal")
    expect(r.reason).toBe("noise_event")
  })

  test("admitWork surfaces a resolution refusal as a typed wiring error", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const err = yield* wiringFailureOf(
          EventAdmissionWiring.admitWork(db, {
            event: verifiedCommand(registry),
            registration: commandReg,
            scope: verifiedScope({ verifiedSource: undefined }),
            adapter: recorder([]),
            now: 10,
          }),
        )
        expect(err).toBeInstanceOf(EventAdmissionWiring.EventAdmissionWiringError)
        if (!(err instanceof EventAdmissionWiring.EventAdmissionWiringError)) return
        expect(err.reason).toBe("unverified_trust_refused")
        expect(err.eventId).toBe("e-1")
      }),
    )
  })

  test("when the V2 admission switch is OFF, admitWork is a typed admission_disabled refusal", async () => {
    process.env[EventAdmission.EVENT_V2_ADMISSION_ENV] = "false"
    try {
      await run(
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const err = yield* wiringFailureOf(
            EventAdmissionWiring.admitWork(db, {
              event: verifiedCommand(registry),
              registration: commandReg,
              scope: verifiedScope(),
              adapter: recorder([]),
              now: 10,
            }),
          )
          expect(err).toBeInstanceOf(EventAdmission.EventAdmissionError)
          if (!(err instanceof EventAdmission.EventAdmissionError)) return
          expect(err.reason).toBe("admission_disabled")
        }),
      )
    } finally {
      process.env[EventAdmission.EVENT_V2_ADMISSION_ENV] = "true"
    }
  })
})
