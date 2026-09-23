import { describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Model } from "@deepagent-code/llm"
import { route } from "@deepagent-code/llm/protocols/openai-chat"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { EventTable } from "@deepagent-code/core/event/sql"
import { ModelV2 } from "@deepagent-code/core/model"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { toLLMMessages } from "@deepagent-code/core/session/runner/to-llm-message"
import { SessionTable, SessionMessageTable } from "@deepagent-code/core/session/sql"
import { ToolOutput } from "@deepagent-code/core/tool-output"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const it = testEffect(Layer.mergeAll(database, events, projector))
const timestamp = DateTime.makeUnsafe(1)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }

const content = (text: string) => [ToolOutput.text({ type: "text", text })]

describe("Tool.Progress", () => {
  it.effect("projects durable progress and keeps final settlements durable", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const service = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_tool_progress_projector")
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "progress",
          directory: "/project",
          title: "progress",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const assistantMessageID = SessionMessage.ID.create()
      yield* service.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp,
        agent: "build",
        model,
      })
      const readAssistant = Effect.gen(function* () {
        const row = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, assistantMessageID))
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* Effect.die("Missing projected assistant")
        return Schema.decodeUnknownSync(SessionMessage.Assistant)({ ...row.data, id: row.id, type: row.type })
      })
      const start = (callID: string) =>
        Effect.gen(function* () {
          yield* service.publish(SessionEvent.Tool.Input.Started, {
            sessionID,
            timestamp,
            assistantMessageID,
            callID,
            name: "bash",
          })
          yield* service.publish(SessionEvent.Tool.Called, {
            sessionID,
            timestamp,
            assistantMessageID,
            callID,
            tool: "bash",
            input: { command: "pwd" },
            provider: { executed: false },
          })
        })

      yield* start("call-success")
      expect((yield* readAssistant).content[0]).toMatchObject({
        state: { status: "running", structured: {}, content: [] },
      })

      yield* service.publish(SessionEvent.Tool.Progress, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-success",
        structured: { phase: "checkpoint" },
        content: content("saved"),
      })
      expect((yield* readAssistant).content[0]).toMatchObject({
        state: { status: "running", structured: { phase: "checkpoint" }, content: content("saved") },
      })

      const success = yield* service.publish(SessionEvent.Tool.Success, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-success",
        structured: { phase: "done" },
        content: content("complete"),
        provider: { executed: false },
      })
      expect((yield* readAssistant).content[0]).toMatchObject({
        state: { status: "completed", structured: { phase: "done" }, content: content("complete") },
      })

      yield* start("call-failed")
      yield* service.publish(SessionEvent.Tool.Progress, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-failed",
        structured: { phase: "checkpoint" },
        content: content("before failure"),
      })
      const failed = yield* service.publish(SessionEvent.Tool.Failed, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-failed",
        error: { type: "unknown", message: "boom" },
        provider: { executed: false },
      })
      expect((yield* readAssistant).content[1]).toMatchObject({
        state: {
          status: "error",
          structured: { phase: "checkpoint" },
          content: content("before failure"),
          error: { type: "unknown", message: "boom" },
        },
      })
      expect(Schema.is(SessionEvent.Durable)(success)).toBe(true)
      expect(Schema.is(SessionEvent.Durable)(failed)).toBe(true)

      const rows = yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      expect(rows.map((row) => row.type)).toContain(EventV2.versionedType(SessionEvent.Tool.Progress.type, 1))
      expect(rows.map((row) => row.type)).toContain(EventV2.versionedType(SessionEvent.Tool.Success.type, 1))
      expect(rows.map((row) => row.type)).toContain(EventV2.versionedType(SessionEvent.Tool.Failed.type, 1))
    }),
  )
})

describe("Tool.Failed classification", () => {
  it.effect("folds the classified refusal and rebuilds the exact wording for the model", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const service = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_tool_failed_classification")
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "failed",
          directory: "/project",
          title: "failed",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const assistantMessageID = SessionMessage.ID.create()
      yield* service.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp,
        agent: "build",
        model,
      })
      yield* service.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-refused",
        name: "edit",
      })
      yield* service.publish(SessionEvent.Tool.Called, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-refused",
        tool: "edit",
        input: { path: "README.md" },
        provider: { executed: false },
      })
      const wording =
        "The user rejected permission to use this specific tool call with the following feedback: use write instead"
      const result = { type: "error", value: wording, metadata: { failureCode: "user_corrected_permission" } }
      yield* service.publish(SessionEvent.Tool.Failed, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-refused",
        error: { type: "permission_corrected", message: wording },
        result,
        provider: { executed: false },
      })

      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, assistantMessageID))
        .get()
        .pipe(Effect.orDie)
      const assistant = yield* Effect.gen(function* () {
        if (!row) return yield* Effect.die("Missing projected assistant")
        return Schema.decodeUnknownSync(SessionMessage.Assistant)({ ...row.data, id: row.id, type: row.type })
      })
      expect(assistant.content[0]).toMatchObject({
        state: {
          status: "error",
          error: { type: "permission_corrected", message: wording },
          result,
        },
      })

      // BUG-V2.0-003 guard: history reload reuses the persisted result, so the model reads the
      // exact refusal wording; the classification metadata rides along without altering the text.
      const llmModel = Model.make({ id: "model", provider: "provider", route })
      const rebuilt = toLLMMessages([assistant], llmModel)
      expect(rebuilt[1]?.content).toMatchObject([{ type: "tool-result", id: "call-refused", name: "edit", result }])
    }),
  )
})
