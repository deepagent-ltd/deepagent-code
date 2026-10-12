import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { eq, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Attention } from "../src/attention"
import { Database } from "../src/database/database"
import { SessionRestart } from "../src/session/execution/restart"
import { SessionSchema } from "../src/session/schema"
import { SessionStore } from "../src/session/store"
import { SessionTable } from "../src/session/sql"
import { V2ToolEffect } from "../src/session/runner/v2-tool-effect"
import { V2ToolEffectAdmissionTable } from "../src/session/runner/v2-tool-effect.sql"
import { WorkspaceV2 } from "../src/workspace"
import { capability, services } from "./fixture/attention"

// The subprocess uses the actual runner, coordinator, provider receipts and tool admissions.
// Only its provider stream and external tool are deterministic seams; no live model is used.
test.each([false, true])(
  "discovers a real unknown tool after claim release (provider failed: %s)",
  async (providerFailed) => {
    const root = await mkdtemp(path.join(tmpdir(), "attention-unknown-process-"))
    await Promise.all(["home", "tmp", "config", "data", "cache", "state"].map((name) => mkdir(path.join(root, name))))
    const filename = path.join(root, "authority.sqlite")
    try {
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          "test",
          "./test/session-runner.test.ts",
          "--test-name-pattern",
          "quarantines an unknown tool outcome without replaying its body",
          "--timeout",
          "20000",
        ],
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
          DEEPAGENT_TEST_RUNNER_PROVIDER_FAILED: String(providerFailed),
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ status, output: status === 0 ? "ok" : stdout + stderr }).toEqual({ status: 0, output: "ok" })
      const result = await Bun.file(`${filename}.dispatch.json`).json()
      expect(result).toMatchObject({
        providerCalls: 1,
        toolBodies: 1,
        providerState: providerFailed ? "indeterminate_after_crash" : "settled",
        pending: 1,
      })
      // The fixture has already migrated this file. Open the real persisted source directly so
      // inventory bootstrap cannot rewrite it before the read-only discovery assertions.
      const database = Layer.effect(
        Database.Service,
        EffectDrizzleSqlite.makeWithDefaults().pipe(Effect.map((db) => ({ db }))),
      ).pipe(Layer.provide(SqliteClient.layer({ filename })))
      const item = await Effect.gen(function* () {
        const attention = yield* Attention.Service
        const store = yield* SessionStore.Service
        const restart = yield* SessionRestart.Service
        const db = (yield* Database.Service).db
        const sessionID = SessionSchema.ID.make("ses_unknown_tool_outcome")
        expect(yield* store.claimToken(sessionID)).toBeUndefined()
        expect(yield* restart.pendingRecovery).toEqual([])
        const before = yield* db.get<{ value: number }>(sql`SELECT total_changes() AS value`).pipe(Effect.orDie)
        const page = yield* attention.list({ kind: "execution_recovery" })
        expect(page.data).toHaveLength(1)
        expect(page.unseenCount).toBe(1)
        const item = page.data[0]!
        expect(item).toMatchObject({
          state: "recovery_required",
          reasonCode: "recovery_required",
          occurredAt: null,
          session: { id: sessionID, workspaceID: null },
          seen: false,
        })
        expect(item.source.activityID).toBeString()
        expect(item.id).toMatch(/^recovery:[a-f0-9]{64}$/)
        expect(item.revision).toMatch(/^[a-f0-9]{64}$/)
        expect(JSON.stringify(item)).not.toContain(result.admissionID)
        expect(yield* attention.get(item.id)).toMatchObject({ id: item.id, revision: item.revision })
        expect(yield* db.get(sql`SELECT total_changes() AS value`).pipe(Effect.orDie)).toEqual(before)
        expect(yield* attention.seen(item.id, item.revision)).toMatchObject({ seen: true, state: "recovery_required" })
        expect(yield* db.get<{ value: number }>(sql`SELECT total_changes() AS value`).pipe(Effect.orDie)).toEqual({
          value: before!.value + 1,
        })
        expect(yield* attention.list({ view: "unseen" })).toMatchObject({ data: [], unseenCount: 0 })
        expect((yield* attention.list()).data).toHaveLength(1)
        expect(yield* store.claimToken(sessionID)).toBeUndefined()
        return item
      }).pipe(Effect.provide(services(filename, undefined, capability, database)), Effect.scoped, Effect.runPromise)
      expect(await Bun.file(`${filename}.body`).text()).toBe("dispatched\n")

      await Effect.gen(function* () {
        const attention = yield* Attention.Service
        const restart = yield* SessionRestart.Service
        const store = yield* SessionStore.Service
        const db = (yield* Database.Service).db
        const sessionID = SessionSchema.ID.make(item.session.id)
        expect(yield* attention.get(item.id)).toMatchObject({ revision: item.revision, seen: true })
        const admission = (yield* db.select().from(V2ToolEffectAdmissionTable).all().pipe(Effect.orDie))[0]!
        expect(JSON.stringify(item)).not.toContain(admission.owner_token)
        // Missing or contradictory ownership proof must not create additional recovery cards.
        yield* db
          .insert(V2ToolEffectAdmissionTable)
          .values([
            {
              ...admission,
              admission_id: "invalid-owner",
              tool_call_id: "invalid-owner",
              owner_token: "missing-owner",
            },
            {
              ...admission,
              admission_id: "invalid-receipt",
              tool_call_id: "invalid-receipt",
              receipt_id: "missing-receipt",
            },
            {
              ...admission,
              admission_id: "invalid-attempt",
              tool_call_id: "invalid-attempt",
              provider_attempt_id: "missing-attempt",
            },
          ])
          .run()
          .pipe(Effect.orDie)
        expect((yield* attention.list()).data).toHaveLength(1)
        expect(yield* restart.pendingToolEffectsFor([])).toEqual([])
        yield* db
          .update(SessionTable)
          .set({ workspace_id: WorkspaceV2.ID.make("wrk_remote") })
          .where(eq(SessionTable.id, sessionID))
          .run()
          .pipe(Effect.orDie)
        expect((yield* attention.list()).data).toEqual([])
        expect(yield* restart.pendingToolEffectsFor([sessionID])).toEqual([])
        expect(yield* attention.get(item.id).pipe(Effect.flip)).toBeInstanceOf(Attention.NotFound)
        yield* db
          .update(SessionTable)
          .set({ workspace_id: null, v2_authority: false })
          .where(eq(SessionTable.id, sessionID))
          .run()
          .pipe(Effect.orDie)
        expect((yield* attention.list()).data).toEqual([])
        expect(yield* restart.pendingToolEffectsFor([sessionID])).toEqual([])
        yield* db
          .update(SessionTable)
          .set({ v2_authority: true })
          .where(eq(SessionTable.id, sessionID))
          .run()
          .pipe(Effect.orDie)
        expect(yield* attention.get(item.id)).toMatchObject({ revision: item.revision, seen: true })
        // Existing claim-based inventory and this adapter never duplicate the same source.
        const token = yield* store.claim(sessionID)
        expect(token).toBeNumber()
        expect((yield* attention.list()).data).toHaveLength(1)
        expect(yield* restart.pendingToolEffectsFor([sessionID])).toEqual([])
        expect(yield* store.release(sessionID, token!)).toBe(true)
        expect(yield* attention.get(item.id)).toMatchObject({ revision: item.revision, seen: true })
        // Two genuine admissions in one provider turn are distinct occurrences and page once each.
        const effects = yield* V2ToolEffect.Service
        const input = {
          sessionId: admission.session_id,
          providerAttemptId: admission.provider_attempt_id,
          receiptId: admission.receipt_id,
          toolCallId: admission.tool_call_id,
          toolName: admission.tool_name,
          effectKind: admission.effect_kind,
          ownerToken: admission.owner_token,
          now: Date.now(),
        }
        yield* effects.admit({ ...input, toolCallId: "second-call" })
        const first = yield* attention.list({ limit: 1 })
        const second = yield* attention.list({ limit: 1, cursor: first.nextCursor })
        expect(first.unseenCount).toBe(1)
        expect(second.unseenCount).toBe(1)
        expect(new Set([...first.data, ...second.data].map((entry) => entry.id)).size).toBe(2)
        expect(second.nextCursor).toBeUndefined()
        yield* effects.record({ ...input, state: "settled", outcomeHash: "a".repeat(64) })
        expect(yield* attention.get(item.id).pipe(Effect.flip)).toBeInstanceOf(Attention.NotFound)
        expect(yield* attention.seen(item.id, item.revision).pipe(Effect.flip)).toBeInstanceOf(Attention.NotFound)
        expect((yield* attention.list()).data).toHaveLength(1)
        yield* effects.record({
          ...input,
          toolCallId: "second-call",
          state: "failed",
          errorCode: "fixture_terminal_failure",
          outcomeHash: "b".repeat(64),
        })
        expect(yield* attention.list()).toMatchObject({ data: [], unseenCount: 0 })
        expect(yield* store.claimToken(sessionID)).toBeUndefined()
      }).pipe(
        Effect.provide(
          Layer.merge(
            services(filename, undefined, capability, database),
            V2ToolEffect.layer.pipe(Layer.provide(database)),
          ),
        ),
        Effect.scoped,
        Effect.runPromise,
      )
      expect(await Bun.file(`${filename}.body`).text()).toBe("dispatched\n")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  60_000,
)
