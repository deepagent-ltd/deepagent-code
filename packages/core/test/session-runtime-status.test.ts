import { describe, expect } from "bun:test"
import { Database } from "@deepagent-code/core/database/database"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionRestart } from "@deepagent-code/core/session/execution/restart"
import { SessionRuntimeStatus } from "@deepagent-code/core/session/runtime-status"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { SessionStore } from "@deepagent-code/core/session/store"
import { Effect, Layer } from "effect"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const activeID = SessionSchema.ID.make("ses_runtime_active")
const recoveryID = SessionSchema.ID.make("ses_runtime_recovery")
const idleID = SessionSchema.ID.make("ses_runtime_idle")
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set([activeID])),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.void,
    awaitIdle: () => Effect.void,
  }),
)
const store = SessionStore.layer.pipe(Layer.provide(database))
const restart = SessionRestart.layer.pipe(Layer.provide(database), Layer.provide(execution), Layer.provide(store))
const status = SessionRuntimeStatus.layer.pipe(Layer.provide(execution), Layer.provide(restart))
const it = testEffect(Layer.mergeAll(database, execution, store, restart, status))

describe("SessionRuntimeStatus", () => {
  it.effect("distinguishes process-owned work from orphaned durable claims", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values(
          [activeID, recoveryID, idleID].map((id) => ({
            id,
            project_id: ProjectV2.ID.global,
            slug: id,
            directory: AbsolutePath.make("/project"),
            title: id,
            version: "test",
            execution_claim_token: id === idleID ? null : 1,
          })),
        )
        .run()
        .pipe(Effect.orDie)

      // A bare claim with no receipts classifies claim_only: the redrive releases it, so the
      // listing carries recovery_required WITHOUT a blocked reason and blockedRedrives is empty.
      expect(Object.fromEntries(yield* SessionRuntimeStatus.Service.use((service) => service.list))).toEqual({
        [activeID]: { status: "busy" },
        [recoveryID]: { status: "recovery_required" },
      })
      expect(yield* SessionRuntimeStatus.Service.use((service) => service.blockedRedrives)).toEqual([])
    }),
  )

  it.effect("surfaces the typed blocked reason for a claim the redrive can never release", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      // The kill-9 authority-conflict shape: a claimed Session whose provider turn is bound to
      // a foreign execution-claim token (the in-flight turn belongs to an older owner chain,
      // so the redrive fences the release instead of replaying it).
      const sessionID = SessionSchema.ID.make("ses_runtime_blocked")
      const foreignToken = Date.now() - 10_000
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: ProjectV2.ID.global,
          slug: "blocked",
          directory: AbsolutePath.make("/project"),
          title: "blocked",
          version: "test",
          execution_claim_token: foreignToken,
        })
        .run()
        .pipe(Effect.orDie)
      const inputID = "msg_runtime_blocked"
      const dbNow = `CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`
      yield* db.run(`
        INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created)
        VALUES ('${inputID}', '${sessionID}', '{"text":"turn"}', 'steer', 0, 0, 1)
      `).pipe(Effect.orDie)
      yield* db.run(`
        INSERT INTO session_activity (activity_id, session_id, ordinal, trigger_input_id, delivery, state, created_at)
        VALUES ('activity_runtime_blocked', '${sessionID}', 0, '${inputID}', 'steer', 'active', 1)
      `).pipe(Effect.orDie)
      // The receipt insert guard demands a live owner lease; the turn then stays owned by the
      // FOREIGN claim token (no provider_attempt row), and the lease is released after the
      // insert so the classification is an authority conflict, not owned_elsewhere.
      yield* db.run(`
        INSERT INTO session_provider_owner_lease
          (owner_token, registered_at, heartbeat_at, lease_expires_at, released_at)
        VALUES ('owner_runtime_blocked', ${dbNow}, ${dbNow}, ${dbNow} + 3600000, NULL)
      `).pipe(Effect.orDie)
      yield* db.run(`
        INSERT INTO session_v2_provider_turn_receipt (
          receipt_id, session_id, request_ordinal, activity_id, provider_turn_seq,
          user_message_id, history_prompt_epoch, request_input_hash, provider_id, model_id,
          protocol, owner_mode, owner_token, state, created_at
        ) VALUES (
          'receipt_runtime_blocked', '${sessionID}', 1, 'activity_runtime_blocked', 1,
          '${inputID}', 0, '${"b".repeat(64)}', 'provider-test', 'model-test',
          'openai-chat', 'v2', 'owner_runtime_blocked', 'preparing', 1
        )
      `).pipe(Effect.orDie)
      yield* db.run(`
        UPDATE session_provider_owner_lease SET released_at = ${dbNow}
        WHERE owner_token = 'owner_runtime_blocked'
      `).pipe(Effect.orDie)

      const restartService = yield* SessionRestart.Service
      expect((yield* restartService.pendingRecovery)[0]?.disposition).toBe("authority_conflict")
      expect(yield* SessionRuntimeStatus.Service.use((service) => service.blockedRedrives)).toEqual([
        { sessionID, blockedReason: "authority_conflict" },
      ])
      expect(Object.fromEntries(yield* SessionRuntimeStatus.Service.use((service) => service.list))).toEqual({
        // The shared execution stub still owns ses_runtime_active.
        [activeID]: { status: "busy" },
        [sessionID]: { status: "recovery_required", blockedReason: "authority_conflict" },
      })
    }),
  )
})
