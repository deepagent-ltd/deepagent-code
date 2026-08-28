import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { Effect } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { ImSingleWrite } from "@deepagent-code/core/deepagent/im-single-write"
import { imSingleWriteMigration } from "@deepagent-code/core/deepagent/im-single-write-sql"
import { EventAdmission } from "@deepagent-code/core/deepagent/event-admission"
import { eventAdmissionMigration } from "@deepagent-code/core/deepagent/event-admission-sql"
import { EventWorkEnvelope } from "@deepagent-code/core/deepagent/event-work-envelope"
import type { EventTypeRegistration, RegisteredEventEnvelope } from "@deepagent-code/core/deepagent/event-registry"
import { assertPublishable, createEventRegistry } from "@deepagent-code/core/deepagent/event-registry"
import { commandEnvelope, HASH } from "./event-fixture"
import type { WorkBudget, WorkContextQuery } from "@deepagent-code/core/contract/event-envelope"

// C5-09 — IM single-write: one durable receipt + one execution owner through the E4a admission bridge;
// OFF defaults to `im_single_write_unavailable` + legacy behavior preserved; ownership fencing rejects a
// competing owner. Design §B1 (the IM double-write) + §8.4 (bounded envelope admission receipt).

type Db = Database.Interface["db"]

const imReg: EventTypeRegistration = {
  eventType: "im.message.created",
  kind: "command",
  schemaId: "im.message.created.schema",
  schemaVersion: "1",
  payloadContentType: "application/json",
  payloadVersion: "v1",
  allowedProducerKinds: ["system"],
  allowedSourceKinds: ["user"],
  causation: { allowed: ["causedByEventId"], requiresCause: false },
  risk: "medium",
  objective: "process the IM message",
  requestedCapability: "deepagent.im.process",
  autonomyCeiling: "medium",
}

const imRegistry = createEventRegistry([imReg])

const budget: WorkBudget = {
  maxTokens: 8000,
  maxToolCalls: 4,
  maxDurationMs: 60000,
  hourTokensMax: 4000,
  hourWindowMinutes: 60,
  workspaceBudgetId: "wb-1",
  agentBudgetId: "ab-1",
  eventRoot: "im://1",
}

const contextQuery: WorkContextQuery = { intent: "related", query: "advance the goal" }

const resolution = () => ({
  trust: { level: "verified" as const, sourceRef: "ctx://src/1" },
  permission: { scopes: ["im.read"], required: ["im.write"], maxAutonomy: "medium" as const },
  egress: { allowedDomains: ["plugins"], allowedSensitivities: ["public"] },
  budget,
  securityNamespaceId: "ns-1",
  projectScopeKey: "psc-1",
  contextQuery,
})

const imEnvelope = (eventId: string): RegisteredEventEnvelope => {
  const envelope = commandEnvelope({
    eventId,
    eventType: "im.message.created",
    producer: { producerId: "im-1", producerKind: "system" },
    source: { sourceId: "im-1", sourceKind: "user" },
    schema: { schemaId: "im.message.created.schema", schemaVersion: "1" },
  })
  return assertPublishable(imRegistry, envelope)
}

function build(event: RegisteredEventEnvelope) {
  const result = EventWorkEnvelope.build({
    event,
    registration: imReg,
    resolution: resolution(),
    verifiedFacts: [{ factId: "f-1", factHash: "fh" }],
  })
  if (!result.ok) throw new Error(result.message)
  return result.envelope
}

const run = <A, E>(code: (db: Db) => Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* DatabaseMigration.applyOnly(db, [imSingleWriteMigration, eventAdmissionMigration])
      return yield* code(db)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )

const refusalOf = <A>(effect: Effect.Effect<A, ImSingleWrite.ImSingleWriteError>): Effect.Effect<ImSingleWrite.ImSingleWriteError | undefined> =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => error,
      onSuccess: () => undefined,
    }),
  )

const SESSION = "ses_im_single_write"

/** A recording SessionV2 adapter: counts how many times the session admitted the IM work. */
const recorder = (calls: Array<Record<string, unknown>>, after: () => void = () => {}): EventAdmission.SessionWorkAdapter => ({
  admit: (input) =>
    Effect.sync(() => {
      calls.push({ imMessageId: input.envelope.eventRef, delivery: input.delivery, resume: input.resume })
      after()
      return {}
    }),
})

const savedAdmission = process.env[EventAdmission.EVENT_V2_ADMISSION_ENV]
const savedSingle = process.env[ImSingleWrite.IM_SINGLE_WRITE_ENV]

describe("C5-09 IM single-write", () => {
  beforeAll(() => {
    process.env[EventAdmission.EVENT_V2_ADMISSION_ENV] = "true"
    process.env[ImSingleWrite.IM_SINGLE_WRITE_ENV] = "true"
  })
  afterAll(() => {
    const restore = (key: string, saved: string | undefined) => {
      if (saved === undefined) delete process.env[key]
      else process.env[key] = saved
    }
    restore(EventAdmission.EVENT_V2_ADMISSION_ENV, savedAdmission)
    restore(ImSingleWrite.IM_SINGLE_WRITE_ENV, savedSingle)
  })

  test("ON: a new IM input records ONE receipt + ONE owner; the adapter is called exactly ONCE", async () => {
    await run((db) =>
      Effect.gen(function* () {
        const calls: Array<Record<string, unknown>> = []
        const envelope = build(imEnvelope("e-im-1"))
        const result = yield* ImSingleWrite.admit(db, {
          imMessageId: "msg-1",
          envelope,
          sessionID: SESSION,
          ownerID: "owner-1",
          sessionAdapter: recorder(calls),
          now: 10,
        })
        expect(result.kind).toBe("single_written")
        if (result.kind !== "single_written") return
        expect(result.row.ownerId).toBe("owner-1")
        expect(result.row.imMessageId).toBe("msg-1")
        expect(result.row.receiptRef).toMatch(/^[0-9a-f]{64}$/)
        expect(result.row.status).toBe("single_written")
        // ONE execution owner, ONE adapter call.
        expect(calls.length).toBe(1)
        // Exactly one receipt row.
        expect((yield* ImSingleWrite.forImMessage(db, "msg-1"))?.imMessageId).toBe("msg-1")
      }),
    )
  })

  test("ON: a redelivered IM input (same owner) → one execution, adapter NOT re-called", async () => {
    await run((db) =>
      Effect.gen(function* () {
        const calls: Array<Record<string, unknown>> = []
        const envelope = build(imEnvelope("e-im-2"))
        const first = yield* ImSingleWrite.admit(db, {
          imMessageId: "msg-2",
          envelope,
          sessionID: SESSION,
          ownerID: "owner-1",
          sessionAdapter: recorder(calls),
          now: 10,
        })
        expect(first.kind).toBe("single_written")
        // Redelivery = exact retry by the SAME owner → existing receipt, no second execution.
        const again = yield* ImSingleWrite.admit(db, {
          imMessageId: "msg-2",
          envelope,
          sessionID: SESSION,
          ownerID: "owner-1",
          sessionAdapter: recorder(calls),
          now: 20,
        })
        expect(again.kind).toBe("existing_owner")
        if (again.kind !== "existing_owner") return
        expect(again.row.imMessageId).toBe("msg-2")
        // The SessionV2 adapter was NOT re-called → one execution total.
        expect(calls.length).toBe(1)
      }),
    )
  })

  test("ON: ownership fencing — a competing owner is a typed refusal, never a second execution", async () => {
    await run((db) =>
      Effect.gen(function* () {
        const calls: Array<Record<string, unknown>> = []
        const envelope = build(imEnvelope("e-im-3"))
        yield* ImSingleWrite.admit(db, {
          imMessageId: "msg-3",
          envelope,
          sessionID: SESSION,
          ownerID: "owner-A",
          sessionAdapter: recorder(calls),
          now: 10,
        })
        const err = yield* refusalOf(
          ImSingleWrite.admit(db, {
            imMessageId: "msg-3",
            envelope,
            sessionID: SESSION,
            ownerID: "owner-B",
            sessionAdapter: recorder(calls),
            now: 20,
          }),
        )
        expect(err?.reason).toBe("already_owned")
        // The competing owner never caused a second execution.
        expect(calls.length).toBe(1)
      }),
    )
  })

  test("ON: crash recovery — an IM input already admitted by the E4a bridge does not double-execute", async () => {
    await run((db) =>
      Effect.gen(function* () {
        const envelope = build(imEnvelope("e-im-4"))
        // Simulate a crash AFTER the E4a admission bridge admitted the envelope but BEFORE the IM
        // single-write ledger row was written: admit the same envelope directly through the bridge.
        const bridgeCalls: Array<Record<string, unknown>> = []
        const bridge = yield* EventAdmission.admit(db, {
          envelope,
          sessionID: SESSION,
          adapter: recorder(bridgeCalls),
          now: 10,
        })
        if (bridge.kind !== "admitted") throw new Error("expected admitted")
        expect(bridgeCalls.length).toBe(1)
        // The IM single-write retry sees NO IM ledger row, asks the bridge, which returns exact_retry
        // (same envelope identity + digest) WITHOUT re-calling the SessionV2 adapter.
        const retryCalls: Array<Record<string, unknown>> = []
        const result = yield* ImSingleWrite.admit(db, {
          imMessageId: "msg-4",
          envelope,
          sessionID: SESSION,
          ownerID: "owner-1",
          sessionAdapter: recorder(retryCalls),
          now: 20,
        })
        expect(result.kind).toBe("single_written")
        // One execution total: the bridge was not re-driven, and the IM ledger got its single receipt.
        expect(retryCalls.length).toBe(0)
        expect((yield* ImSingleWrite.forImMessage(db, "msg-4"))?.receiptRef).toBe(bridge.row.envelopeDigest)
      }),
    )
  })

  test("OFF: the single-write path is a typed `im_single_write_unavailable` (legacy path authoritative)", async () => {
    process.env[ImSingleWrite.IM_SINGLE_WRITE_ENV] = "false"
    try {
      await run((db) =>
        Effect.gen(function* () {
          const envelope = build(imEnvelope("e-im-5"))
          const err = yield* refusalOf(
            ImSingleWrite.admit(db, {
              imMessageId: "msg-5",
              envelope,
              sessionID: SESSION,
              ownerID: "owner-1",
              sessionAdapter: recorder([]),
              now: 10,
            }),
          )
          expect(err?.reason).toBe("im_single_write_unavailable")
        }),
      )
    } finally {
      process.env[ImSingleWrite.IM_SINGLE_WRITE_ENV] = "true"
    }
  })
})
