import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect, Exit, Layer } from "effect"
import { Database } from "../src/database/database"
import { V2ToolEffect } from "../src/session/runner/v2-tool-effect"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const effects = V2ToolEffect.layer.pipe(Layer.provide(database))
const it = testEffect(Layer.mergeAll(database, effects))

const record = (service: V2ToolEffect.Interface, overrides: Record<string, unknown> = {}) =>
  service.record({
    sessionId: "ses_tool_effect",
    providerAttemptId: "attempt_tool_effect",
    receiptId: "receipt_tool_effect",
    toolCallId: "call_tool_effect",
    toolName: "echo",
    effectKind: "mutating",
    state: "settled",
    outcomeHash: "a".repeat(64),
    ownerToken: "owner_tool_effect",
    now: 1_000,
    ...overrides,
  })

describe("V2 tool effect authority", () => {
  it.effect("records exactly one terminal row per settled call", () =>
    Effect.gen(function* () {
      const service = yield* V2ToolEffect.Service
      const effect = yield* record(service)
      expect(effect).toMatchObject({
        sessionId: "ses_tool_effect",
        providerAttemptId: "attempt_tool_effect",
        receiptId: "receipt_tool_effect",
        toolCallId: "call_tool_effect",
        state: "settled",
        effectKind: "mutating",
      })
      expect(effect.errorCode).toBeUndefined()
      expect(yield* service.listForSession("ses_tool_effect")).toHaveLength(1)
    }),
  )

  it.effect("converges exact re-settlement and refuses divergent outcomes", () =>
    Effect.gen(function* () {
      const service = yield* V2ToolEffect.Service
      const first = yield* record(service)
      const same = yield* record(service)
      expect(same.effectId).toBe(first.effectId)
      expect(yield* service.listForSession("ses_tool_effect")).toHaveLength(1)
      expect(
        yield* record(service, { outcomeHash: "b".repeat(64) }).pipe(Effect.exit),
      ).toMatchObject({ _tag: "Failure" })
      expect(
        yield* record(service, { receiptId: "receipt_other", state: "failed", errorCode: "tool_error" }).pipe(
          Effect.exit,
        ),
      ).toMatchObject({ _tag: "Success" })
    }),
  )

  it.effect("admits only terminal states with matching error evidence", () =>
    Effect.gen(function* () {
      const service = yield* V2ToolEffect.Service
      // failed requires an error code; settled must not carry one (insert guard is fail-closed).
      const failed = yield* record(service, {
        toolCallId: "call_failed",
        state: "failed",
        errorCode: "tool_settlement_failed",
      })
      expect(failed).toMatchObject({ state: "failed", errorCode: "tool_settlement_failed" })
      const databaseService = yield* Database.Service
      const reject = (values: string) =>
        databaseService.db.run(sql`
        INSERT INTO session_v2_tool_effect (
          effect_id, session_id, provider_attempt_id, receipt_id, tool_call_id, tool_name,
          effect_kind, state, outcome_hash, error_code, owner_token, time_created
        ) VALUES ${sql.raw(`(${values})`)}
      `).pipe(Effect.exit)
      const base = "'ses_tool_effect', 'attempt_tool_effect', 'receipt_tool_effect'"
      // settled carrying an error code
      expect(
        (yield* reject(`'t1', ${base}, 'c1', 'echo', 'mutating', 'settled', '${"c".repeat(64)}', 'wrong', 'o', 1`))._tag,
      ).toBe("Failure")
      // failed without an error code
      expect(
        (yield* reject(`'t2', ${base}, 'c2', 'echo', 'mutating', 'failed', '${"c".repeat(64)}', NULL, 'o', 1`))._tag,
      ).toBe("Failure")
      // failed with a blank error code
      expect(
        (yield* reject(`'t3', ${base}, 'c3', 'echo', 'mutating', 'failed', '${"c".repeat(64)}', ' ', 'o', 1`))._tag,
      ).toBe("Failure")
      // non-terminal state
      expect(
        (yield* reject(`'t4', ${base}, 'c4', 'echo', 'mutating', 'running', '${"c".repeat(64)}', NULL, 'o', 1`))._tag,
      ).toBe("Failure")
      // unknown effect kind
      expect(
        (yield* reject(`'t5', ${base}, 'c5', 'echo', 'destructive', 'settled', '${"c".repeat(64)}', NULL, 'o', 1`))._tag,
      ).toBe("Failure")
      // uppercase outcome hash
      expect(
        (yield* reject(`'t6', ${base}, 'c6', 'echo', 'mutating', 'settled', '${"C".repeat(64)}', NULL, 'o', 1`))._tag,
      ).toBe("Failure")
      // short outcome hash
      expect(
        (yield* reject(`'t7', ${base}, 'c7', 'echo', 'mutating', 'settled', 'abcd', NULL, 'o', 1`))._tag,
      ).toBe("Failure")
      // blank owner token
      expect(
        (yield* reject(`'t8', ${base}, 'c8', 'echo', 'mutating', 'settled', '${"c".repeat(64)}', NULL, ' ', 1`))._tag,
      ).toBe("Failure")
    }),
  )

  it.effect("binds permission grant evidence and refuses divergent grant re-settlement", () =>
    Effect.gen(function* () {
      const service = yield* V2ToolEffect.Service
      const grant = { receiptId: "grant_receipt", ownerId: "grant_owner", state: "settled" as const, version: 3 }
      const effect = yield* record(service, { toolCallId: "call_granted", grant })
      expect(effect.grant).toEqual(grant)
      // Exact re-settlement with the identical grant converges.
      expect((yield* record(service, { toolCallId: "call_granted", grant })).effectId).toBe(effect.effectId)
      // A different grant version for the same call is a conflict, never an overwrite.
      expect(
        yield* record(service, {
          toolCallId: "call_granted",
          grant: { ...grant, version: 4 },
        }).pipe(Effect.exit),
      ).toMatchObject({ _tag: "Failure" })
      // A grant-less re-settlement converges on the recorded grant evidence: replay determinism
      // must not depend on a possibly unavailable grant lookup, and the recorded evidence is
      // never weakened.
      const converged = yield* record(service, { toolCallId: "call_granted" })
      expect(converged.effectId).toBe(effect.effectId)
      expect(converged.grant).toEqual(grant)
    }),
  )

  it.effect("admits grant evidence only all-or-nothing", () =>
    Effect.gen(function* () {
      const databaseService = yield* Database.Service
      const reject = (values: string) =>
        databaseService.db.run(sql`
        INSERT INTO session_v2_tool_effect (
          effect_id, session_id, provider_attempt_id, receipt_id, tool_call_id, tool_name,
          effect_kind, state, outcome_hash, error_code, grant_receipt_id, grant_owner_id, grant_state, grant_version,
          owner_token, time_created
        ) VALUES ${sql.raw(`(${values})`)}
      `).pipe(Effect.exit)
      const base = "'ses_tool_effect', 'attempt_tool_effect', 'receipt_tool_effect'"
      const hash = `'${"a".repeat(64)}'`
      // complete grant evidence is admitted
      expect(
        (
          yield* reject(
            `'g_ok', ${base}, 'call_g1', 'echo', 'mutating', 'settled', ${hash}, NULL, 'gr', 'go', 'settled', 1, 'o', 1`,
          )
        )._tag,
      ).toBe("Success")
      // partial grant evidence (missing owner) is rejected
      expect(
        (
          yield* reject(
            `'g_bad1', ${base}, 'call_g2', 'echo', 'mutating', 'settled', ${hash}, NULL, 'gr', NULL, 'settled', 1, 'o', 1`,
          )
        )._tag,
      ).toBe("Failure")
      // unknown grant state is rejected
      expect(
        (
          yield* reject(
            `'g_bad2', ${base}, 'call_g3', 'echo', 'mutating', 'settled', ${hash}, NULL, 'gr', 'go', 'running', 1, 'o', 1`,
          )
        )._tag,
      ).toBe("Failure")
      // negative grant version is rejected
      expect(
        (
          yield* reject(
            `'g_bad3', ${base}, 'call_g4', 'echo', 'mutating', 'settled', ${hash}, NULL, 'gr', 'go', 'settled', -1, 'o', 1`,
          )
        )._tag,
      ).toBe("Failure")
    }),
  )

  it.effect("keeps recorded effects immutable and append only", () =>
    Effect.gen(function* () {
      const service = yield* V2ToolEffect.Service
      yield* record(service)
      const databaseService = yield* Database.Service
      const updated = yield* databaseService.db
        .run(sql`UPDATE session_v2_tool_effect SET state = 'failed' WHERE receipt_id = 'receipt_tool_effect'`)
        .pipe(Effect.exit)
      expect(updated._tag).toBe("Failure")
      const deleted = yield* databaseService.db
        .run(sql`DELETE FROM session_v2_tool_effect WHERE receipt_id = 'receipt_tool_effect'`)
        .pipe(Effect.exit)
      expect(deleted._tag).toBe("Failure")
      expect(yield* service.listForSession("ses_tool_effect")).toHaveLength(1)
    }),
  )
})
