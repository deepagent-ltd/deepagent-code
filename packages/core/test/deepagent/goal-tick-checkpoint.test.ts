import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Schema } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../../src/database/database"
import { EventV2 } from "../../src/event"
import { SessionEvent } from "../../src/session/event"
import { SessionV2 } from "../../src/session"
import { GoalControl } from "../../src/deepagent/goal-control"
import { GoalChildPolicy } from "../../src/deepagent/goal-child-policy"
import { GoalChild } from "../../src/deepagent/goal-child"
import { GoalTickCheckpoint } from "../../src/deepagent/goal-tick-checkpoint"
import { GoalTickCheckpointSchema } from "../../src/deepagent/goal-tick-checkpoint.schema"
import { GoalChildC1Fixture } from "../fixture/goal-child-c1"
import { GoalChildFixture } from "../fixture/goal-child"
import { AgentV2 } from "../../src/agent"
import { DateTime } from "effect"
import { SessionMessage } from "../../src/session/message"
import { SessionSchema } from "../../src/session/schema"
import { ModelV2 } from "../../src/model"
import { ProviderV2 } from "../../src/provider"

function code<A, E>(exit: Exit.Exit<A, E>) {
  if (Exit.isSuccess(exit)) return "success"
  const error = Cause.squash(exit.cause)
  return error instanceof GoalTickCheckpointSchema.Error ? error.code : String(error)
}

test("actual neutral parent update advances only the checked frontier and retains frozen prompt", () =>
  GoalChildC1Fixture.isolated(({ directory }) =>
    Effect.gen(function* () {
      const setup = yield* GoalChildC1Fixture.prepare(directory)
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      yield* sessions.update({ sessionID: setup.parent.id, title: "neutral title" })
      yield* db.transaction((tx) => GoalTickCheckpoint.requireParent(tx, setup.checkpoint), { behavior: "immediate" })
      const after = (yield* GoalTickCheckpoint.read(db, setup.permit.permit_id))!
      expect(after.parent_checked_through_seq).toBeGreaterThan(setup.checkpoint.parent_checked_through_seq)
      expect(after.journal.parent).toEqual(setup.checkpoint.journal.parent)
      expect(after.journal.roles).toEqual(setup.checkpoint.journal.roles)
    }),
  ))

for (const change of ["agent", "permissions", "model"] as const) {
  test(`parent ${change} ABA invalidates the old tick before child admission`, () =>
    GoalChildC1Fixture.isolated(({ directory }) =>
      Effect.gen(function* () {
        const setup = yield* GoalChildC1Fixture.prepare(directory)
        const db = (yield* Database.Service).db
        const sessions = yield* SessionV2.Service
        const events = yield* EventV2.Service
        const timestamp = yield* DateTime.now
        if (change === "agent") {
          yield* events.publish(SessionEvent.AgentSwitched, {
            sessionID: setup.parent.id,
            agent: AgentV2.ID.make("worker"),
            timestamp,
            messageID: SessionMessage.ID.create(),
          })
          const original = yield* GoalControl.session(db, setup.parent.id)
          yield* events.publish(SessionEvent.Updated, {
            sessionID: setup.parent.id,
            info: setup.parent,
            slug: original.slug,
            version: original.version,
          })
        }
        if (change === "permissions") {
          yield* sessions.setPermissions({
            sessionID: setup.parent.id,
            permissions: [{ action: "*", resource: "*", effect: "deny" }],
          })
          yield* sessions.setPermissions({ sessionID: setup.parent.id, permissions: setup.parent.permissions })
        }
        if (change === "model") {
          const original = yield* GoalControl.session(db, setup.parent.id)
          yield* events.publish(SessionEvent.ModelSwitched, {
            sessionID: setup.parent.id,
            model: { providerID: ProviderV2.ID.make("fixture"), id: ModelV2.ID.make("changed") },
            timestamp,
            messageID: SessionMessage.ID.create(),
          })
          yield* events.publish(SessionEvent.Updated, {
            sessionID: setup.parent.id,
            info: setup.parent,
            slug: original.slug,
            version: original.version,
          })
        }
        expect(
          GoalControl.fingerprint(GoalTickCheckpoint.authority(yield* GoalControl.session(db, setup.parent.id))),
        ).toBe(setup.checkpoint.journal.parent.authorityHash)
        const result = yield* db
          .transaction((tx) => GoalTickCheckpoint.requireParent(tx, setup.checkpoint), { behavior: "immediate" })
          .pipe(Effect.exit)
        expect(code(result)).toBe("PARENT_AUTHORITY_CHANGED")
        expect(yield* db.all(sql`SELECT unit_id FROM goal_child_unit`)).toHaveLength(0)
      }),
    ))
}

test("unknown event and missing durable event cannot be classified as neutral", () =>
  GoalChildC1Fixture.isolated(({ directory }) =>
    Effect.gen(function* () {
      const setup = yield* GoalChildC1Fixture.prepare(directory)
      const db = (yield* Database.Service).db
      const unknown = EventV2.define({
        type: "c1.future",
        sync: { aggregate: "sessionID", version: 7 },
        schema: { sessionID: SessionSchema.ID, value: Schema.String },
      })
      yield* (yield* EventV2.Service).publish(unknown, { sessionID: setup.parent.id, value: "new event" })
      expect(code(yield* GoalTickCheckpoint.requireParent(db, setup.checkpoint).pipe(Effect.exit))).toBe(
        "PARENT_AUTHORITY_CHANGED",
      )
      yield* db.run(sql`DELETE FROM event WHERE aggregate_id=${setup.parent.id} AND type='c1.future.7'`)
      expect(code(yield* GoalTickCheckpoint.requireParent(db, setup.checkpoint).pipe(Effect.exit))).toBe(
        "PARENT_HISTORY_UNAVAILABLE",
      )
    }),
  ))

test("large mirror budgets reject before any child/input/provider and preserve the old reservation", () =>
  GoalChildC1Fixture.isolated(({ directory }) =>
    Effect.gen(function* () {
      const setup = yield* GoalChildC1Fixture.prepare(directory)
      const tooLarge = {
        ...setup.checkpoint.journal,
        budgets: {
          ...setup.checkpoint.journal.budgets,
          mirrors: Array.from({ length: 8 }, (_, i) => ({ documentID: `doc:plan:${i}`, bytes: 262144 })),
        },
      }
      expect(code(yield* GoalTickCheckpoint.validate(tooLarge).pipe(Effect.exit))).toBe("CHECKPOINT_CAPACITY")
      const db = (yield* Database.Service).db
      expect((yield* GoalTickCheckpoint.read(db, setup.permit.permit_id))?.reserved_bytes).toBe(1048576)
      expect(yield* db.all(sql`SELECT * FROM session_v2_provider_turn_receipt`)).toHaveLength(0)
    }),
  ))

test("checkpoint reservation counts canonical UTF8 escapes and rejects forged cursor, duplicate semantic roles", () =>
  GoalChildC1Fixture.isolated(({ directory }) =>
    Effect.gen(function* () {
      const setup = yield* GoalChildC1Fixture.prepare(directory)
      const db = (yield* Database.Service).db
      const base = setup.checkpoint.journal
      const payload = "\u0000".repeat(1000)
      const escaped = {
        ...base,
        budgets: { ...base.budgets, mirrors: [{ documentID: "doc:plan:one", bytes: 4096 }] },
        mirrors: [
          {
            documentID: "doc:plan:one",
            expectedVersion: 1,
            expectedHash: `sha256:${"a".repeat(64)}`,
            payload,
            payloadHash: GoalControl.fingerprint(payload),
            state: "pending" as const,
            observedVersion: null,
            observedHash: null,
          },
        ],
      }
      expect(payload.length).toBeLessThan(4096)
      expect(code(yield* GoalTickCheckpoint.validate(escaped).pipe(Effect.exit))).toBe("CHECKPOINT_CAPACITY")
      const duplicate = {
        ...base,
        roles: [...base.roles, { ...base.roles[0], key: "different-key" }],
        budgets: { ...base.budgets, resultSlots: 2 },
      }
      expect(code(yield* GoalTickCheckpoint.validate(duplicate).pipe(Effect.exit))).toBe("CHECKPOINT_INVALID")
      const changed = { ...base, cursor: { role: 1, stage: "plain" as const } }
      yield* db.run(
        sql`UPDATE goal_tick_checkpoint SET journal=${JSON.stringify(changed)},journal_hash=${GoalControl.fingerprint(changed)},logical_bytes=${Buffer.byteLength(JSON.stringify(changed))} WHERE permit_id=${setup.permit.permit_id}`,
      )
      expect(code(yield* GoalTickCheckpoint.read(db, setup.permit.permit_id).pipe(Effect.exit))).toBe(
        "CHECKPOINT_RECOVERY_REQUIRED",
      )
      expect(yield* db.all("SELECT * FROM goal_child_unit")).toHaveLength(0)
    }),
  ))

test("immutable permit token is part of checkpoint binding, not a replaceable bearer field", () =>
  GoalChildC1Fixture.isolated(({ directory }) =>
    Effect.gen(function* () {
      const setup = yield* GoalChildC1Fixture.prepare(directory)
      const db = (yield* Database.Service).db
      yield* db.run(sql`UPDATE goal_tick_permit SET token='different-token' WHERE permit_id=${setup.permit.permit_id}`)
      expect(code(yield* GoalTickCheckpoint.read(db, setup.permit.permit_id).pipe(Effect.exit))).toBe(
        "CHECKPOINT_RECOVERY_REQUIRED",
      )
      expect(yield* db.all("SELECT * FROM session_v2_provider_turn_receipt")).toHaveLength(0)
    }),
  ))

test("maximum compact native result fits the reserved slot without character-to-byte ambiguity", () => {
  const ref = "x".repeat(128)
  const count = Number.MAX_SAFE_INTEGER
  const result = {
    version: 1 as const,
    unitID: ref,
    stage: "finalizer.2" as const,
    inputID: ref,
    admittedSeq: count,
    activityID: ref,
    messageID: ref,
    executionID: ref,
    claimToken: count,
    providers: { count, through: count, hash: "a".repeat(64) },
    tools: { count, through: count, hash: "b".repeat(64) },
    outcome: "schema_invalid" as const,
    resultHash: "c".repeat(64),
    schemaHash: "d".repeat(64),
    usage: {
      input: count,
      nonCachedInput: count,
      output: count,
      reasoning: count,
      visibleOutput: count,
      cacheRead: count,
      cacheWrite: count,
    },
    usageDerivation: {
      version: 1 as const,
      inferredInputCategories: ["nonCachedInput", "cacheRead", "cacheWrite"] as const,
    },
  }
  expect(Schema.is(GoalTickCheckpointSchema.Result)(result)).toBe(true)
  expect(Buffer.byteLength(GoalTickCheckpoint.canonical(result))).toBeLessThanOrEqual(
    GoalTickCheckpointSchema.RESULT_BYTES,
  )
  expect(Schema.is(GoalTickCheckpointSchema.Result)({ ...result, activityID: "界".repeat(128) })).toBe(false)
})

test("actual global SQL reservation refuses a new tick while retaining unknown tombstone capacity", () =>
  GoalChildC1Fixture.isolated(({ directory }) =>
    Effect.gen(function* () {
      const setup = yield* GoalChildC1Fixture.prepare(directory)
      const db = (yield* Database.Service).db
      yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            yield* tx.run(sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<255)
      INSERT INTO goal_tick_permit (permit_id,goal_id,tick_seq,control_revision,plan_version,owner_id,token,state,child_sessions,interrupt_state,created_at)
      SELECT 'capacity-'||i,goal_id,i,control_revision,plan_version,owner_id,token,'unknown',child_sessions,'unconfirmed',created_at FROM goal_tick_permit,n WHERE permit_id=${setup.permit.permit_id}`)
            yield* tx.run(sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<255)
      INSERT INTO goal_tick_checkpoint (permit_id,goal_id,tick_seq,version,revision,binding_hash,role_manifest_hash,parent_checked_through_seq,state,journal,journal_hash,logical_bytes,reserved_bytes,error_code,created_at,updated_at)
      SELECT 'capacity-'||i,goal_id,i,version,revision,binding_hash,role_manifest_hash,parent_checked_through_seq,'recovery_required',journal,journal_hash,logical_bytes,reserved_bytes,'CHECKPOINT_RECOVERY_REQUIRED',created_at,updated_at FROM goal_tick_checkpoint,n WHERE permit_id=${setup.permit.permit_id}`)
          }),
        { behavior: "immediate" },
      )
      const before = yield* db.all<{ records: number; bytes: number }>(
        "SELECT count(*) AS records,sum(reserved_bytes) AS bytes FROM goal_tick_checkpoint",
      )
      expect(before[0]).toEqual({ records: 256, bytes: 268435456 })
      const next = yield* GoalChildFixture.prepare(directory)
      const result = yield* GoalTickCheckpoint.begin(db, {
        permitID: next.permit.permit_id,
        permitToken: next.permit.token,
        roles: setup.checkpoint.journal.roles,
        budgets: setup.checkpoint.journal.budgets,
      }).pipe(Effect.exit)
      expect(code(result)).toBe("CHECKPOINT_CAPACITY")
      expect(
        yield* db.all("SELECT count(*) AS records,sum(reserved_bytes) AS bytes FROM goal_tick_checkpoint"),
      ).toEqual(before)
      expect(yield* db.all("SELECT * FROM goal_child_unit")).toHaveLength(0)
      expect(yield* db.all("SELECT * FROM session_v2_provider_turn_receipt")).toHaveLength(0)
    }),
  ))
