import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { eq, sql } from "drizzle-orm"
import { Effect, Fiber, Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Database } from "../src/database/database"
import { SessionExecution } from "../src/session/execution"
import { SessionRestart } from "../src/session/execution/restart"
import { SessionRuntimeStatus } from "../src/session/runtime-status"
import { SessionSchema } from "../src/session/schema"
import { SessionStore } from "../src/session/store"
import { SessionTable } from "../src/session/sql"
import { V2ToolEffect } from "../src/session/runner/v2-tool-effect"
import { V2ToolEffectAdmissionTable } from "../src/session/runner/v2-tool-effect.sql"
import { capability, seedSession, services } from "./fixture/attention"

// The positive source comes from the production runner/coordinator/receipt/tool admission
// path. Its provider stream and external tool are controlled; this test never calls a model.
test("surfaces released-claim tool recovery without executing, and preserves exact discovery boundaries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "runtime-tool-recovery-"))
  await Promise.all(["home", "tmp", "config", "data", "cache", "state"].map((name) => mkdir(path.join(root, name))))
  const filename = path.join(root, "authority.sqlite")
  try {
    const child = Bun.spawn({
      cmd: [process.execPath, "test", "./test/session-runner.test.ts", "--test-name-pattern",
        "quarantines an unknown tool outcome without replaying its body", "--timeout", "20000"],
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        PATH: process.env.PATH,
        HOME: path.join(root, "home"),
        TMPDIR: path.join(root, "tmp"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
        DEEPAGENT_TEST_RUNNER_EFFECT_DB: filename,
        DEEPAGENT_TEST_RUNNER_EFFECT_PHASE: "dispatch",
        DEEPAGENT_TEST_RUNNER_PROVIDER_FAILED: "false",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    expect({ code, output: code === 0 ? "ok" : stdout + stderr }).toEqual({ code: 0, output: "ok" })
    expect(await Bun.file(`${filename}.dispatch.json`).json()).toMatchObject({
      providerCalls: 1, toolBodies: 1, providerState: "settled", pending: 1,
    })
    // Reopen the already migrated file without bootstrap changing the source under test.
    const database = Layer.effect(Database.Service,
      EffectDrizzleSqlite.makeWithDefaults().pipe(Effect.map((db) => ({ db })))).pipe(
      Layer.provide(SqliteClient.layer({ filename })),
    )
    const batches: number[] = []
    const shared = services(filename, () => Effect.never, capability, database)
    const traced = Layer.effect(SessionRestart.Service, Effect.gen(function* () {
      const restart = yield* SessionRestart.Service
      return SessionRestart.Service.of({ ...restart, pendingToolEffectsFor: (ids) => {
        batches.push(ids.length)
        return restart.pendingToolEffectsFor(ids)
      } })
    })).pipe(Layer.provideMerge(shared))
    const runtime = SessionRuntimeStatus.layer.pipe(Layer.provideMerge(traced))
    await Effect.gen(function* () {
      const status = yield* SessionRuntimeStatus.Service
      const store = yield* SessionStore.Service
      const execution = yield* SessionExecution.Service
      const db = (yield* Database.Service).db
      const sessionID = SessionSchema.ID.make("ses_unknown_tool_outcome")
      const before = yield* db.get<{ value: number }>(sql`SELECT total_changes() AS value`).pipe(Effect.orDie)
      expect(yield* store.claimToken(sessionID)).toBeUndefined()
      expect(yield* SessionRestart.Service.use((restart) => restart.pendingRecovery)).toEqual([])
      expect((yield* status.list).get(sessionID)).toEqual({ status: "recovery_required", blockedReason: "recovery_required" })
      expect(yield* status.get!(sessionID)).toEqual({ status: "recovery_required", blockedReason: "recovery_required" })
      expect(yield* status.blockedRedrives).toEqual([])
      expect(yield* db.get(sql`SELECT total_changes() AS value`).pipe(Effect.orDie)).toEqual(before)
      expect(yield* execution.active).toEqual(new Set())

      // A live process owner still wins over durable claim discovery. The actual coordinator
      // runs a held Location runner; it performs no provider or tool operation.
      const busy = yield* seedSession(yield* Database.Service, "busy")
      const running = yield* execution.resume(busy).pipe(Effect.forkChild)
      yield* Effect.gen(function* () {
        while (!(yield* execution.active).has(busy)) yield* Effect.yieldNow
      })
      expect((yield* status.list).get(busy)).toEqual({ status: "busy" })
      expect(yield* status.get!(busy)).toEqual({ status: "busy" })
      expect((yield* status.list).get(sessionID)?.status).toBe("recovery_required")
      yield* execution.interrupt(busy)
      yield* Fiber.await(running)
      expect((yield* status.list).has(busy)).toBe(false)

      const admission = (yield* db.select().from(V2ToolEffectAdmissionTable)
        .where(eq(V2ToolEffectAdmissionTable.session_id, sessionID)).all().pipe(Effect.orDie))[0]!
      // fixture-exempt: cross-Session copies are discovery candidates, never valid authority.
      // 257 rejects plus the genuine source exercise two SQLite batches without replacing
      // the exact production receipt/attempt/owner classifier.
      yield* Effect.forEach(globalThis.Array.from({ length: 257 }, (_, index) => index), (index) => Effect.gen(function* () {
        const id = yield* seedSession(yield* Database.Service, `candidate_${index}`)
        yield* db.insert(V2ToolEffectAdmissionTable).values({ ...admission,
          session_id: id, admission_id: `candidate_${index}`, tool_call_id: `candidate_${index}`,
        }).run().pipe(Effect.orDie)
      }), { concurrency: 1, discard: true })
      batches.length = 0
      const inventoryBefore = yield* db.get(sql`SELECT total_changes() AS value`).pipe(Effect.orDie)
      expect([...yield* status.list]).toEqual([[sessionID, { status: "recovery_required", blockedReason: "recovery_required" }]])
      expect(batches).toEqual([256, 2])
      expect(yield* db.get(sql`SELECT total_changes() AS value`).pipe(Effect.orDie)).toEqual(inventoryBefore)
      batches.length = 0
      expect(yield* status.get!(sessionID)).toEqual({ status: "recovery_required", blockedReason: "recovery_required" })
      expect(batches).toEqual([1])
      expect(yield* status.get!(SessionSchema.ID.make("ses_attention_candidate_0"))).toBeUndefined()
      expect(yield* status.get!(SessionSchema.ID.make("ses_absent_runtime_status"))).toBeUndefined()
      expect(batches).toEqual([1, 1])
      expect(yield* db.get(sql`SELECT total_changes() AS value`).pipe(Effect.orDie)).toEqual(inventoryBefore)

      const effects = yield* V2ToolEffect.Service
      const input = {
        sessionId: admission.session_id, providerAttemptId: admission.provider_attempt_id,
        receiptId: admission.receipt_id, toolCallId: admission.tool_call_id,
        toolName: admission.tool_name, effectKind: admission.effect_kind,
        ownerToken: admission.owner_token, now: Date.now(),
      }
      yield* effects.record({ ...input, state: "settled", outcomeHash: "a".repeat(64) })
      expect((yield* status.list).size).toBe(0)
      // Missing owner, receipt or attempt cannot create a recovery status after the genuine
      // admission has a terminal. The original Session/claim remain untouched.
      yield* db.insert(V2ToolEffectAdmissionTable).values([
        { ...admission, admission_id: "invalid_owner", tool_call_id: "invalid_owner", owner_token: "missing_owner" },
        { ...admission, admission_id: "invalid_receipt", tool_call_id: "invalid_receipt", receipt_id: "missing_receipt" },
        { ...admission, admission_id: "invalid_attempt", tool_call_id: "invalid_attempt", provider_attempt_id: "missing_attempt" },
      ]).run().pipe(Effect.orDie)
      expect((yield* status.list).size).toBe(0)
      const readInput = { ...input, toolCallId: "second_call", toolName: "read", effectKind: "read_only" as const }
      yield* effects.admit(readInput)
      expect((yield* status.list).get(sessionID)?.status).toBe("recovery_required")
      yield* effects.record({ ...readInput, state: "failed",
        errorCode: "fixture_terminal_failure", outcomeHash: "b".repeat(64) })
      expect((yield* status.list).size).toBe(0)
      expect(yield* store.claimToken(sessionID)).toBeUndefined()
      expect((yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).all().pipe(Effect.orDie))[0]?.execution_claim_token).toBeNull()
    }).pipe(Effect.provide(Layer.merge(runtime, V2ToolEffect.layer.pipe(Layer.provide(database)))), Effect.scoped, Effect.runPromise)
    expect(await Bun.file(`${filename}.body`).text()).toBe("dispatched\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
