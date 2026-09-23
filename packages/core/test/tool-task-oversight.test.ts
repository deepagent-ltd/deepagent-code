import { describe, expect } from "bun:test"
import { count, eq } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { Project } from "@deepagent-code/core/project"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { V2StructuredOutputEvidenceTable } from "@deepagent-code/core/session/runner/v2-structured-output-evidence.sql"
import { V2TaskRunReceiptTable } from "@deepagent-code/core/session/runner/v2-task-run-receipt.sql"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionMessageTable, TaskRunTable } from "@deepagent-code/core/session/sql"
import { SessionStore } from "@deepagent-code/core/session/store"
import { TaskRunAuthority } from "@deepagent-code/core/session/task-run"
import { Delegation } from "@deepagent-code/core/tool/delegation"
import { ToolRegistry } from "@deepagent-code/core/tool/registry"
import { TaskStatusTool } from "@deepagent-code/core/tool/task-status"
import { TaskReadTool } from "@deepagent-code/core/tool/task-read"
import { TaskCloseTool } from "@deepagent-code/core/tool/task-close"
import { TaskRecoveryTool } from "@deepagent-code/core/tool/task-recovery"
import { PRFinalizeTool } from "@deepagent-code/core/tool/pr-finalize"
import { TaskTool } from "@deepagent-code/core/tool/task"
import { testEffect } from "./lib/effect"
import { executeTool, settleTool, toolIdentity } from "./lib/tool"

// WS4b-S1: the V2 task oversight tool surface (task_status / task_read / task_close /
// task_recovery) over the durable task_run ledger — exercised through the real ToolRegistry with
// the production delegation-slot wiring (the tools read SessionV2 through the same capture the
// root composition performs).

const assertions: PermissionV2.AssertInput[] = []

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.sync(() => assertions.push(input)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const stackOver = (database: Layer.Layer<Database.Service, unknown>) => {
  const events = EventV2.layer.pipe(Layer.provide(database))
  const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const sessions = SessionV2.layer.pipe(
    Layer.provide(events),
    Layer.provide(database),
    Layer.provide(SessionStore.layer.pipe(Layer.provide(database))),
    Layer.provide(Project.defaultLayer),
    Layer.provide(SessionExecution.noopLayer),
  )
  const coreStack = Layer.mergeAll(database, events, projector, sessions)
  const registry = ToolRegistry.defaultLayer
  const tools = Layer.mergeAll(
    TaskStatusTool.layer,
    TaskReadTool.layer,
    TaskCloseTool.layer,
    TaskRecoveryTool.layer,
    PRFinalizeTool.layer,
  ).pipe(Layer.provide(registry), Layer.provide(permission))
  // Same wiring as the production root (v2-runner-frame): one memoized slot + one SessionV2 build.
  const delegation = TaskTool.captureDelegationServiceLayer.pipe(
    Layer.provide(Delegation.delegationSlotLayer),
    Layer.provide(coreStack),
  )
  return Layer.mergeAll(coreStack, registry, permission, tools, delegation, Delegation.delegationSlotLayer)
}

const it = testEffect(stackOver(Database.layerFromPath(":memory:")))

const services = Effect.gen(function* () {
  return {
    db: (yield* Database.Service).db,
    events: yield* EventV2.Service,
    sessions: yield* SessionV2.Service,
    registry: yield* ToolRegistry.Service,
  }
})

const directory = AbsolutePath.make("/tmp")

const specFor = (parentSessionID: SessionSchema.ID, toolCallID: string, outputSchema?: Record<string, unknown>) => ({
  parentSessionID,
  parentMessageID: SessionMessage.ID.make(`msg_parent_${toolCallID}`),
  toolCallID,
  deliveryMode: "foreground" as const,
  prompt: new Prompt({ text: "Research and report the answer." }),
  agent: "general",
  ...(outputSchema === undefined ? {} : { outputSchema }),
  child: {
    title: `task: ${toolCallID}`,
    location: { directory },
    permissions: [{ action: "edit", resource: "*", effect: "deny" as const }],
  },
})

const call = (name: string, input: unknown, sessionID: SessionSchema.ID, id = `call-${name}-1`) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name, input },
})

const runRow = (db: Database.Interface["db"], runID: string) =>
  db
    .select()
    .from(TaskRunTable)
    .where(eq(TaskRunTable.run_id, runID))
    .get()
    .pipe(Effect.orDie)

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

const insertMessage = (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  seq: number,
  plain: unknown,
) => {
  const message = decodeMessage(plain)
  return db
    .insert(SessionMessageTable)
    .values({
      id: message.id,
      session_id: sessionID,
      type: message.type,
      seq,
      data: encodeMessage(message),
    })
    .run()
    .pipe(Effect.orDie, Effect.as(message))
}

/** A settled (completed) shared run with a raw result binding, plus a fabricated transcript. */
const settledRunWithResult = (toolCallID: string) =>
  Effect.gen(function* () {
    const { db, events, sessions, registry } = yield* services
    const parent = yield* sessions.create({ location: { directory } })
    const submitted = yield* TaskRunAuthority.submit(db, events, sessions, specFor(parent.id, toolCallID))
    const child = submitted.run.childSessionID
    const resultMessage = yield* insertMessage(db, child, 1, {
      id: "msg_result_1",
      type: "assistant",
      agent: "general",
      model: { id: "m", providerID: "p" },
      content: [{ type: "text", id: "part_result", text: "RAW FINAL ANSWER" }],
      time: { created: 1_000 },
    })
    const claimed = yield* TaskRunAuthority.claim(db, {
      runID: submitted.run.runID,
      ownerToken: `owner-${toolCallID}`,
      leaseMs: 60_000,
      now: 1_000,
    })
    yield* TaskRunAuthority.settle(db, {
      runID: submitted.run.runID,
      ownerToken: `owner-${toolCallID}`,
      claimGeneration: claimed.claimGeneration,
      state: "completed",
      reason: "done",
      output: "RAW FINAL ANSWER",
      rawResultMessageID: resultMessage.id,
      now: 2_000,
    })
    return { db, parent, run: submitted.run, child, registry }
  })

describe("task_status (WS4b-S1)", () => {
  it.effect("merges durable children with authoritative task_run rows; run-less children read unknown", () =>
    Effect.gen(function* () {
      const { db, events, sessions, registry } = yield* services
      const parent = yield* sessions.create({ location: { directory } })

      const admitted = yield* TaskRunAuthority.submit(db, events, sessions, specFor(parent.id, "call-status-1"))
      const failed = yield* TaskRunAuthority.submit(db, events, sessions, specFor(parent.id, "call-status-2"))
      const claimed = yield* TaskRunAuthority.claim(db, {
        runID: failed.run.runID,
        ownerToken: "owner-status-2",
        leaseMs: 60_000,
        now: 1_000,
      })
      yield* TaskRunAuthority.settle(db, {
        runID: failed.run.runID,
        ownerToken: "owner-status-2",
        claimGeneration: claimed.claimGeneration,
        state: "failed",
        reason: "child_drain_failed",
        now: 2_000,
      })
      const bare = yield* sessions.create({ parentID: parent.id, title: "bare child", location: { directory } })

      const settlement = yield* settleTool(registry, call("task_status", {}, parent.id))
      expect(settlement.result.type).toBe("text")
      if (settlement.result.type !== "text") return
      const text = String(settlement.result.value)
      expect(text).toContain("3 subagent task(s) dispatched by this session:")
      expect(text).toContain(`- [admitted] general "task: call-status-1"`)
      expect(text).toContain(`id=${admitted.run.childSessionID}`)
      expect(text).toContain(`- [failed] general "task: call-status-2"`)
      expect(text).toContain(`[call task_read({ task_id: "${failed.run.childSessionID}" }) to inspect partial work]`)
      expect(text).toContain(`- [unknown] task "bare child" id=${bare.id}`)

      const structured = settlement.output?.structured as { count?: number } | undefined
      expect(structured?.count).toBe(3)
    }),
  )

  it.effect("shows the recovery_required resolution hint from the durable row", () =>
    Effect.gen(function* () {
      const { db, events, sessions, registry } = yield* services
      const parent = yield* sessions.create({ location: { directory } })
      const submitted = yield* TaskRunAuthority.submit(db, events, sessions, specFor(parent.id, "call-status-3"))
      yield* db
        .update(TaskRunTable)
        .set({ state: "recovery_required" })
        .where(eq(TaskRunTable.run_id, submitted.run.runID))
        .run()
        .pipe(Effect.orDie)

      const result = yield* executeTool(registry, call("task_status", {}, parent.id))
      expect(result.type).toBe("text")
      if (result.type !== "text") return
      expect(String(result.value)).toContain(
        `[resolution required — inspect with task_read, then call task_recovery({ task_id: "${submitted.run.childSessionID}", resolution: "failed" | "closed", reason: "..." }); continuing requires a new task call with the same task_id]`,
      )
    }),
  )
})

describe("task_read (WS4b-S1)", () => {
  it.effect("refuses sessions that are not a direct child of the caller", () =>
    Effect.gen(function* () {
      const { sessions, registry } = yield* services
      const parent = yield* sessions.create({ location: { directory } })
      const stranger = yield* sessions.create({ location: { directory } })

      const missing = yield* executeTool(registry, call("task_read", { task_id: "msg_nope" }, parent.id))
      expect(missing).toMatchObject({ type: "error", value: "task_read: session not found: msg_nope" })

      const boundary = yield* executeTool(registry, call("task_read", { task_id: stranger.id }, parent.id))
      expect(boundary.type).toBe("error")
      if (boundary.type !== "error") return
      expect(String(boundary.value)).toContain(
        `task_read: session ${stranger.id} is not a direct subagent of the current session.`,
      )
    }),
  )

  it.effect("renders the transcript with per-part truncation, skipping synthetic notices and reasoning", () =>
    Effect.gen(function* () {
      const { db, events, sessions, registry } = yield* services
      const parent = yield* sessions.create({ location: { directory } })
      const submitted = yield* TaskRunAuthority.submit(db, events, sessions, specFor(parent.id, "call-read-1"))
      const child = submitted.run.childSessionID
      const longText = "T".repeat(700)
      const longOutput = "O".repeat(500)
      const longError = "E".repeat(300)
      yield* insertMessage(db, child, 1, {
        id: "msg_read_user",
        type: "user",
        text: "research the widget",
        time: { created: 1_000 },
      })
      yield* insertMessage(db, child, 2, {
        id: "msg_read_a2",
        type: "assistant",
        agent: "general",
        model: { id: "m", providerID: "p" },
        content: [
          { type: "text", id: "part_text", text: longText },
          { type: "reasoning", id: "part_think", text: "HIDDEN CHAIN OF THOUGHT" },
          {
            type: "tool",
            id: "part_tool_ok",
            name: "bash",
            state: { status: "completed", input: {}, content: [{ type: "text", text: longOutput }], structured: {} },
            time: { created: 1_100 },
          },
        ],
        time: { created: 1_100 },
      })
      yield* insertMessage(db, child, 3, {
        id: "msg_read_a3",
        type: "assistant",
        agent: "general",
        model: { id: "m", providerID: "p" },
        content: [
          {
            type: "tool",
            id: "part_tool_err",
            name: "edit",
            state: {
              status: "error",
              input: {},
              content: [],
              structured: {},
              error: { type: "unknown", message: longError },
            },
            time: { created: 1_200 },
          },
        ],
        error: { type: "unknown", message: "model blew up" },
        time: { created: 1_200 },
      })
      yield* insertMessage(db, child, 4, {
        id: "msg_read_syn",
        type: "synthetic",
        sessionID: child,
        text: "SYNTHETIC INTERRUPTION NOTICE",
        time: { created: 1_300 },
      })

      const settlement = yield* settleTool(registry, call("task_read", { task_id: child }, parent.id))
      expect(settlement.result.type).toBe("text")
      if (settlement.result.type !== "text") return
      const text = String(settlement.result.value)
      expect(text).toContain(`<task_transcript id="${child}" state="admitted">`)
      expect(text).toContain('<message role="user">research the widget</message>')
      // Text parts truncate at 600 codepoints with an ellipsis.
      expect(text).toContain(`${"T".repeat(599)}…`)
      expect(text).not.toContain("T".repeat(700))
      // Tool completed output truncates at 400.
      expect(text).toContain(`<tool name="bash" state="completed">${"O".repeat(399)}…</tool>`)
      // Tool errors truncate at 200.
      expect(text).toContain(`<tool name="edit" state="error">${"E".repeat(199)}…</tool>`)
      expect(text).toContain("<interruption>model blew up</interruption>")
      // Reasoning stays hidden; synthetic notices are not re-rendered.
      expect(text).not.toContain("HIDDEN CHAIN OF THOUGHT")
      expect(text).not.toContain("SYNTHETIC INTERRUPTION NOTICE")

      const structured = settlement.output?.structured as { messageCount?: number; hasMore?: boolean } | undefined
      expect(structured?.messageCount).toBe(4)
      expect(structured?.hasMore).toBe(false)
    }),
  )

  it.effect("paginates newest-first with the before cursor", () =>
    Effect.gen(function* () {
      const { db, events, sessions, registry } = yield* services
      const parent = yield* sessions.create({ location: { directory } })
      const submitted = yield* TaskRunAuthority.submit(db, events, sessions, specFor(parent.id, "call-read-2"))
      const child = submitted.run.childSessionID
      for (const [seq, text] of [
        [1, "first"],
        [2, "second"],
        [3, "third"],
      ] as const)
        yield* insertMessage(db, child, seq, {
          id: `msg_read_p${seq}`,
          type: "user",
          text,
          time: { created: 1_000 + seq },
        })

      const first = yield* settleTool(registry, call("task_read", { task_id: child, limit: 2 }, parent.id))
      expect(first.result.type).toBe("text")
      if (first.result.type !== "text") return
      const firstText = String(first.result.value)
      expect(firstText).toContain("third")
      expect(firstText).toContain("second")
      expect(firstText).not.toContain("first")
      expect(firstText).toContain('more="true" before="msg_read_p2"')
      const firstStructured = first.output?.structured as { hasMore?: boolean; before?: string } | undefined
      expect(firstStructured?.hasMore).toBe(true)
      expect(firstStructured?.before).toBe("msg_read_p2")

      const second = yield* executeTool(
        registry,
        call("task_read", { task_id: child, limit: 2, before: "msg_read_p2" }, parent.id, "call-task_read-2"),
      )
      expect(second.type).toBe("text")
      if (second.type !== "text") return
      expect(String(second.value)).toContain("first")
      expect(String(second.value)).not.toContain("third")
      expect(String(second.value)).not.toContain('more="true"')
    }),
  )

  it.effect("returns the durable raw result block for a settled run", () =>
    Effect.gen(function* () {
      const { registry, parent, child } = yield* settledRunWithResult("call-read-3")
      const result = yield* executeTool(registry, call("task_read", { task_id: child }, parent.id))
      expect(result.type).toBe("text")
      if (result.type !== "text") return
      const text = String(result.value)
      expect(text).toContain('<task_result source="raw" message_id="msg_result_1">')
      expect(text).toContain("RAW FINAL ANSWER")
      expect(text).toContain('state="completed"')
    }),
  )

  it.effect("prefers the validated structured-evidence binding over the raw settle binding", () =>
    Effect.gen(function* () {
      const { db, events, sessions, registry } = yield* services
      const parent = yield* sessions.create({ location: { directory } })
      const submitted = yield* TaskRunAuthority.submit(
        db,
        events,
        sessions,
        specFor(parent.id, "call-read-4", { type: "object", properties: { answer: { type: "number" } } }),
      )
      const child = submitted.run.childSessionID
      const verdictMessage = yield* insertMessage(db, child, 1, {
        id: "msg_read_structured",
        type: "assistant",
        agent: "general",
        model: { id: "m", providerID: "p" },
        content: [{ type: "text", id: "part_structured", text: "{\"answer\":42}" }],
        structured: { answer: 42 },
        time: { created: 1_000 },
      })
      const claimed = yield* TaskRunAuthority.claim(db, {
        runID: submitted.run.runID,
        ownerToken: "owner-read-4",
        leaseMs: 60_000,
        now: 1_000,
      })
      yield* TaskRunAuthority.settle(db, {
        runID: submitted.run.runID,
        ownerToken: "owner-read-4",
        claimGeneration: claimed.claimGeneration,
        state: "completed",
        reason: "done",
        output: "{\"answer\":42}",
        now: 2_000,
      })
      yield* TaskRunAuthority.recordStructuredEvidence(db, {
        runId: submitted.run.runID,
        schemaName: "inline",
        schema: { type: "object", properties: { answer: { type: "number" } } },
        validationOutcome: "validated",
        rawOutput: "{\"answer\":42}",
        outputMessageId: verdictMessage.id,
        ownerToken: "core-v2-finalizer:test",
      })

      const result = yield* executeTool(registry, call("task_read", { task_id: child }, parent.id))
      expect(result.type).toBe("text")
      if (result.type !== "text") return
      const text = String(result.value)
      expect(text).toContain('<task_result source="structured" message_id="msg_read_structured">')
      expect(text).toContain('{"answer":42}')
      const evidence = yield* db
        .select({ total: count() })
        .from(V2StructuredOutputEvidenceTable)
        .where(eq(V2StructuredOutputEvidenceTable.run_id, submitted.run.runID))
        .get()
        .pipe(Effect.orDie)
      expect(evidence?.total).toBe(1)
    }),
  )
})

describe("task_close (WS4b-S1)", () => {
  it.effect("closes an admitted run immediately with the durable receipt; a second close reports no open run", () =>
    Effect.gen(function* () {
      const { db, events, sessions, registry } = yield* services
      const parent = yield* sessions.create({ location: { directory } })
      const submitted = yield* TaskRunAuthority.submit(db, events, sessions, specFor(parent.id, "call-close-1"))

      const closed = yield* executeTool(
        registry,
        call("task_close", { task_id: submitted.run.childSessionID, reason: "no longer needed" }, parent.id),
      )
      expect(closed.type).toBe("text")
      if (closed.type !== "text") return
      expect(String(closed.value)).toContain(`Task ${submitted.run.childSessionID} close requested.`)

      const row = yield* runRow(db, submitted.run.runID)
      expect(row?.state).toBe("closed")
      expect(row?.control_state).toBe("closed")
      expect(row?.close_reason).toBe("no longer needed")
      const receipts = yield* db
        .select({ total: count() })
        .from(V2TaskRunReceiptTable)
        .where(eq(V2TaskRunReceiptTable.run_id, submitted.run.runID))
        .get()
        .pipe(Effect.orDie)
      expect(receipts?.total).toBe(1)

      const again = yield* executeTool(
        registry,
        call("task_close", { task_id: submitted.run.childSessionID }, parent.id, "call-task_close-2"),
      )
      expect(again.type).toBe("text")
      if (again.type !== "text") return
      expect(String(again.value)).toContain(`Task ${submitted.run.childSessionID} has no open run`)
    }),
  )

  it.effect("marks a running run close_requested and refuses runs owned by another parent", () =>
    Effect.gen(function* () {
      const { db, events, sessions, registry } = yield* services
      const parent = yield* sessions.create({ location: { directory } })
      const submitted = yield* TaskRunAuthority.submit(db, events, sessions, specFor(parent.id, "call-close-2"))
      yield* TaskRunAuthority.claim(db, {
        runID: submitted.run.runID,
        ownerToken: "owner-close-2",
        leaseMs: 60_000,
        now: 1_000,
      })

      const closed = yield* executeTool(
        registry,
        call("task_close", { task_id: submitted.run.childSessionID }, parent.id),
      )
      expect(closed.type).toBe("text")
      const row = yield* runRow(db, submitted.run.runID)
      expect(row?.state).toBe("running")
      expect(row?.control_state).toBe("close_requested")

      const other = yield* sessions.create({ location: { directory } })
      const foreign = yield* executeTool(
        registry,
        call("task_close", { task_id: submitted.run.childSessionID }, other.id, "call-task_close-3"),
      )
      expect(foreign.type).toBe("error")
      if (foreign.type !== "error") return
      expect(String(foreign.value)).toContain(
        `task_close: ${submitted.run.childSessionID} is not a task dispatched by this session.`,
      )
    }),
  )
})

describe("task_recovery (WS4b-S1)", () => {
  it.effect("requires the recovery_required precondition and asks permission before resolving", () =>
    Effect.gen(function* () {
      const { events, sessions, registry } = yield* services
      const parent = yield* sessions.create({ location: { directory } })
      const submitted = yield* TaskRunAuthority.submit(
        yield* Database.Service.pipe(Effect.map((service) => service.db)),
        events,
        sessions,
        specFor(parent.id, "call-recovery-1"),
      )

      assertions.length = 0
      const result = yield* executeTool(
        registry,
        call(
          "task_recovery",
          { task_id: submitted.run.childSessionID, resolution: "failed", reason: "triage" },
          parent.id,
        ),
      )
      expect(result.type).toBe("error")
      if (result.type !== "error") return
      expect(String(result.value)).toContain(
        `task_recovery: latest run for ${submitted.run.childSessionID} is admitted, not recovery_required`,
      )
      expect(assertions).toHaveLength(0)
    }),
  )

  it.effect("resolves with user approval and cascades the close to descendants in one transaction", () =>
    Effect.gen(function* () {
      const { db, events, sessions, registry } = yield* services
      const parent = yield* sessions.create({ location: { directory } })
      const root = yield* TaskRunAuthority.submit(db, events, sessions, specFor(parent.id, "call-recovery-2"))
      // A descendant run admitted by the root's child session (parent_run_id linkage via admitRun).
      const descendant = yield* TaskRunAuthority.submit(
        db,
        events,
        sessions,
        specFor(root.run.childSessionID, "call-recovery-3"),
      )
      expect((yield* runRow(db, descendant.run.runID))?.parent_run_id).toBe(root.run.runID)
      yield* db
        .update(TaskRunTable)
        .set({ state: "recovery_required" })
        .where(eq(TaskRunTable.run_id, root.run.runID))
        .run()
        .pipe(Effect.orDie)

      assertions.length = 0
      const result = yield* executeTool(
        registry,
        call(
          "task_recovery",
          { task_id: root.run.childSessionID, resolution: "failed", reason: "operator triage" },
          parent.id,
        ),
      )
      expect(result.type).toBe("text")
      if (result.type !== "text") return
      expect(String(result.value)).toContain(
        `Task ${root.run.childSessionID} generation 1 is now failed.`,
      )

      expect(assertions).toHaveLength(1)
      expect(assertions[0]).toMatchObject({
        action: "task_recovery",
        resources: [`${root.run.childSessionID}:failed`],
      })

      const rootRow = yield* runRow(db, root.run.runID)
      expect(rootRow?.state).toBe("failed")
      expect(rootRow?.control_state).toBe("closed")
      const descendantRow = yield* runRow(db, descendant.run.runID)
      expect(descendantRow?.state).toBe("closed")
      expect(descendantRow?.close_reason).toBe("parent_resolved:operator triage")
      const receipts = yield* db
        .select({ total: count() })
        .from(V2TaskRunReceiptTable)
        .get()
        .pipe(Effect.orDie)
      expect(receipts?.total).toBe(2)
    }),
  )
})

describe("pr_finalize guard rails (WS4b-S2)", () => {
  it.effect("reports no eligible runs for a session without isolated work", () =>
    Effect.gen(function* () {
      const { sessions, registry } = yield* services
      const parent = yield* sessions.create({ location: { directory } })
      const result = yield* executeTool(registry, call("pr_finalize", {}, parent.id))
      expect(result).toMatchObject({
        type: "text",
        value: "No review-eligible isolated task runs are queued for this session.",
      })
    }),
  )

  it.effect("refuses non-primary sessions like the legacy tool did", () =>
    Effect.gen(function* () {
      const { sessions, registry } = yield* services
      const parent = yield* sessions.create({ location: { directory } })
      const child = yield* sessions.create({ parentID: parent.id, title: "child", location: { directory } })
      const result = yield* executeTool(registry, call("pr_finalize", {}, child.id))
      expect(result).toMatchObject({ type: "error", value: "Only a primary session may finalize PRs" })
    }),
  )
})
