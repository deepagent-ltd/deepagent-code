import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Fiber, Layer, Schema } from "effect"
import { SessionActivityTable } from "@deepagent-code/core/context-federation/session-sql"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ProxyTenantTable } from "@deepagent-code/core/proxy/sql"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionInputTable, SessionMessageTable } from "@deepagent-code/core/session/sql"
import { SessionStore } from "@deepagent-code/core/session/store"
import { EventV2Bridge } from "@/event-v2-bridge"
import { collectEnhanced, proxyPromptID } from "@/server/routes/instance/httpapi/handlers/gateway-enhanced"
import { testEffect } from "../lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projects = Layer.succeed(ProjectV2.Service, ProjectV2.Service.of({
  resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
  directories: () => Effect.succeed([]),
  commit: () => Effect.void,
}))
const sessions = SessionV2.layer.pipe(
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(SessionStore.layer.pipe(Layer.provide(database))),
  Layer.provide(projects),
  Layer.provide(SessionExecution.noopLayer),
)
const it = testEffect(Layer.mergeAll(
  database,
  events,
  projects,
  SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database)),
  sessions,
  Layer.effect(EventV2Bridge.Service, EventV2.Service).pipe(Layer.provide(events)),
))

it.live("returns a durable terminal completed before deadline after the poll is delayed past it", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const session = yield* SessionV2.Service
    const tenant = {
      id: "tenant-deadline",
      key_hash: "test-hash",
      key_fingerprint: "test-fingerprint",
      directory: "/project",
      model_allowlist: [],
      tier: "context" as const,
      permission_policy: null,
      quota_requests_per_minute: 60,
      quota_tokens_per_day: 100_000,
      lane_limit: 1,
      deadline_ms: 1_000,
      enabled: true,
      created_at: 1,
      updated_at: 1,
    } satisfies typeof ProxyTenantTable.$inferSelect
    const sessionID = SessionV2.ID.make("ses_proxy_deadline_oracle")
    const requestID = "deadline-oracle"
    const promptID = proxyPromptID(tenant, requestID)
    const start = Date.now()
    const deadline = start + tenant.deadline_ms
    let clock = start
    let overduePolls = 0
    const collected = yield* collectEnhanced({
      db,
      sessions: session,
      tenant,
      sessionID,
      hint: "deadline-oracle",
      requestID,
      request: { model: "model", messages: [{ role: "user", content: "Hello" }] },
      providerID: "provider",
      modelID: "model",
      now: () => {
        if (clock > deadline) overduePolls++
        return clock
      },
    }).pipe(Effect.forkChild)

    // Admission and projection use the real SessionV2/EventV2/SQLite layers. Execution is disabled
    // so this test can place a completed provider result before activity settlement deterministically.
    const admitted = yield* Effect.gen(function* () {
      while (true) {
        const row = yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, promptID)).get()
        if (row) return row
        yield* Effect.sleep("5 millis")
      }
    })
    yield* db.update(SessionInputTable).set({ promoted_seq: 1 }).where(eq(SessionInputTable.id, admitted.id)).run()
    yield* db.insert(SessionActivityTable).values({
      activity_id: "activity-deadline-oracle",
      session_id: sessionID,
      ordinal: 0,
      trigger_input_id: promptID,
      delivery: "queue",
      state: "active",
      created_at: start,
    }).run()
    const assistantID = SessionMessage.ID.make("msg_deadline_oracle_assistant")
    const completedAt = start + 100
    const encoded = Schema.encodeSync(SessionMessage.Message)(new SessionMessage.Assistant({
      id: assistantID,
      type: "assistant",
      agent: "build",
      model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
      content: [new SessionMessage.AssistantText({ type: "text", id: "text-1", text: "Done" })],
      finish: "stop",
      time: { created: DateTime.makeUnsafe(start), completed: DateTime.makeUnsafe(completedAt) },
    }))
    yield* db.insert(SessionMessageTable).values({
      id: assistantID,
      session_id: sessionID,
      type: "assistant",
      seq: 2,
      time_created: start,
      data: encoded,
    }).run()

    expect(completedAt).toBeLessThan(deadline)
    clock = deadline + 1
    // The old deadline-bounded loop would exit with 504 on this poll, before settlement.
    yield* Effect.sleep("100 millis")
    expect(overduePolls).toBeGreaterThan(0)
    expect(collected.pollUnsafe()).toBeUndefined()
    clock = deadline + 20
    yield* db.update(SessionActivityTable).set({ state: "settled", settled_at: deadline + 10 })
      .where(eq(SessionActivityTable.activity_id, "activity-deadline-oracle")).run()
    const result = yield* Fiber.join(collected)
    expect(result).toMatchObject({ ok: true, text: "Done", completedAt })
  }),
)
