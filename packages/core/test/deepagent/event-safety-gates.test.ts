import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  validatePublish,
  assertPublishable,
  type EventRegistry,
  EventPublishError,
} from "@deepagent-code/core/deepagent/event-registry"
import { EventWorkEnvelope, type WorkResolution } from "@deepagent-code/core/deepagent/event-work-envelope"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { EventOutbox } from "@deepagent-code/core/deepagent/event-outbox"
import { eventOutboxMigration } from "@deepagent-code/core/deepagent/event-outbox-sql"
import { commandReg, makeRegistry, verifiedCommand, commandEnvelope, HASH } from "./event-fixture"
import type { WorkBudget, WorkContextQuery } from "@deepagent-code/core/contract/event-envelope"

// C5-05 STEP 3 — hard event safety invariants are NON-DISABLEABLE.
//
// Design authority: docs/core-v2.0-beta/design.md §8.
//   - receive-before-dispatch   : an event is only ever dispatcheable from a committed outbox row
//                                 the registry validated (§8.3 transactional outbox / §8.8).
//   - publisher claim/lease      : a row is only settled under the claim token it was issued; a
//                                 stale / mismatched claim (a publisher without a valid claim) is
//                                 fenced (§8.6 claim fencing).
//   - unbounded-envelope         : a model never receives an unbounded payload or noise (§8.4/§8.8).
//   - unregistered event         : an event type the registry has not seeded is never publishable
//                                 (§8.2/§8.8 — a model outputting an arbitrary type cannot self-authorize).
//
// These decisions are PURE functions of their inputs (registry, envelope, claim token) — they do
// NOT read the process environment. A feature toggle must therefore never be able to switch them
// off. These tests set a battery of candidate "disable this safety gate" env vars and assert the
// gate still enforces, proving the invariant is not environment-controllable and guarding against a
// future regression that adds such a hook.

// A battery of plausible names a disable/ bypass hook COULD take. The safety gates must ignore all
// of them: setting them must leave every verdict unchanged.
const DISABLE_ENV_VARS = [
  "DEEPAGENT_CODE_EXPERIMENTAL_DISABLE_EVENT_SAFETY",
  "DEEPAGENT_CODE_DISABLE_EVENT_REGISTRY",
  "DEEPAGENT_CODE_DISABLE_EVENT_OUTBOX",
  "DEEPAGENT_CODE_BYPASS_EVENT_VALIDATION",
  "DEEPAGENT_CODE_DISABLE_PUBLISHER_CLAIM",
]

const savedEnv = new Map<string, string | undefined>()

beforeAll(() => {
  for (const name of DISABLE_ENV_VARS) {
    savedEnv.set(name, process.env[name])
    process.env[name] = "1"
  }
})

afterAll(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

const registry: EventRegistry = makeRegistry()

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

const resolution = (over?: Partial<WorkResolution>): WorkResolution => ({
  trust: { level: "verified", sourceRef: "ctx://src/1" },
  permission: { scopes: ["goal.read"], required: ["goal.write"], maxAutonomy: "medium" },
  egress: { allowedDomains: ["plugins"], allowedSensitivities: ["public"] },
  budget,
  securityNamespaceId: "ns-1",
  projectScopeKey: "psc-1",
  contextQuery,
  ...over,
})

type Db = Database.Interface["db"]

function run<A>(effect: Effect.Effect<A, unknown, Database.Service>): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* DatabaseMigration.applyOnly(db, [eventOutboxMigration])
      return yield* effect
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
}

describe("non-disableable: unregistered event rejection", () => {
  test("an unregistered event type is still refused with the disable env vars set", () => {
    const verdict = validatePublish(registry, commandEnvelope({ eventType: "not.registered" }))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe("unregistered_type")
  })

  test("assertPublishable still throws the typed EventPublishError with the disable env vars set", () => {
    expect(() => assertPublishable(registry, commandEnvelope({ eventType: "not.registered" }))).toThrow(EventPublishError)
  })
})

describe("non-disableable: unbounded-envelope + noise rejection", () => {
  test("an unbounded payload (raw content leaking into the ref) is still refused", () => {
    const raw = commandEnvelope()
    const leak = {
      ...(raw as unknown as Record<string, unknown>),
      payload: { contentType: "application/json", ref: "ctx://p/1", payloadHash: HASH, raw: "SECRET" },
    }
    const result = EventWorkEnvelope.build({
      event: leak as never,
      registration: commandReg,
      resolution: resolution(),
      verifiedFacts: [],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("unbounded_payload")
  })

  test("coordination / operational noise is still refused with the disable env vars set", () => {
    const noise = commandEnvelope({ eventType: "agent.task.started" })
    const result = EventWorkEnvelope.build({
      event: noise as never,
      registration: { ...commandReg, eventType: "agent.task.started" },
      resolution: resolution(),
      verifiedFacts: [],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("noise_event")
  })
})

describe("non-disableable: publisher claim/lease validation", () => {
  test("a publisher without a valid claim cannot mark a row published (fenced) with the disable env vars set", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* EventOutbox.enqueue(db, {
          registry,
          event: verifiedCommand(registry, { eventId: "e-a" }),
          aggregateType: "goal",
          aggregateId: "ag-a",
          now: 10,
        })
        const claim = yield* EventOutbox.claimDue(db, { claimantId: "worker-1", now: 100, leaseMs: 500, limit: 10 })
        expect(claim.rows.length).toBe(1)
        // A publisher holding a DIFFERENT / stale claim token must be fenced: the row is not settled.
        const settled = yield* EventOutbox.markPublished(db, {
          outboxId: claim.rows[0]!.outboxId,
          claimToken: "claim_someone_else_123",
          now: 150,
        })
        expect(settled).toBe(false)
        const row = yield* EventOutbox.getByID(db, claim.rows[0]!.outboxId)
        expect(row?.status).toBe("publishing")
        expect(row?.claimToken).toBe(claim.claimToken)
      }),
    )
  })

  test("a publisher without a claim (no settlement fenced) never dispatches", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* EventOutbox.enqueue(db, {
          registry,
          event: verifiedCommand(registry, { eventId: "e-b" }),
          aggregateType: "goal",
          aggregateId: "ag-b",
          now: 10,
        })
        // The outbox only dispatches rows the publisher CLAIMED under its own lease; an unclaimed
        // row can never be dispatched by a pump. A claim with a mismatched token is fenced.
        const rows = yield* EventOutbox.pendingRows(db, 999)
        expect(rows.length).toBe(1)
        expect(rows[0]!.status).toBe("pending")
      }),
    )
  })
})
