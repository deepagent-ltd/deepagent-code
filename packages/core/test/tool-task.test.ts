import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import fs from "fs/promises"
import path from "path"
import { AgentV2 } from "@deepagent-code/core/agent"
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
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionMessageTable, SessionInputTable, TaskRunTable } from "@deepagent-code/core/session/sql"
import { V2StructuredOutputEvidenceTable } from "@deepagent-code/core/session/runner/v2-structured-output-evidence.sql"
import { SessionStore } from "@deepagent-code/core/session/store"
import { TaskRunAuthority } from "@deepagent-code/core/session/task-run"
import { Delegation } from "@deepagent-code/core/tool/delegation"
import { ToolRegistry } from "@deepagent-code/core/tool/registry"
import { TaskTool } from "@deepagent-code/core/tool/task"
import { testEffect } from "./lib/effect"
import { executeTool, settleTool, toolIdentity } from "./lib/tool"
import { tmpRoot, tmpRootShared } from "./fixture/tmpdir"

// WS4b task tool surface: S2.1 run visibility (branch/worktree state on the tool result), S3
// bounded result injection (tail-biased cap + task_read pointer), S4 declared file_scope overlap
// warnings — exercised through the real ToolRegistry with the production delegation-slot wiring.

// Redirect the deterministic worktree layout's data root into scratch space for this file.
const dataRoot = tmpRootShared()
const priorTestHome = process.env.DEEPAGENT_CODE_TEST_HOME
const priorDataHome = process.env.DEEPAGENT_CODE_HOME
process.env.DEEPAGENT_CODE_TEST_HOME = dataRoot
process.env.DEEPAGENT_CODE_HOME = dataRoot
afterAll(() => {
  if (priorTestHome === undefined) delete process.env.DEEPAGENT_CODE_TEST_HOME
  else process.env.DEEPAGENT_CODE_TEST_HOME = priorTestHome
  if (priorDataHome === undefined) delete process.env.DEEPAGENT_CODE_HOME
  else process.env.DEEPAGENT_CODE_HOME = priorDataHome
})

// A test-set resume hook lets one case fabricate the child's final assistant turn inside the
// executor drain; everything else keeps the no-op drain.
let resumeHook: ((sessionID: SessionSchema.ID) => Effect.Effect<void>) | undefined
afterEach(() => {
  resumeHook = undefined
})

const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set()),
    resume: (sessionID) => resumeHook?.(sessionID) ?? Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.void,
    awaitIdle: () => Effect.void,
  }),
)

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
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
    Layer.provide(execution),
  )
  const coreStack = Layer.mergeAll(database, events, projector, sessions)
  const registry = ToolRegistry.defaultLayer
  const agents = AgentV2.layer
  const taskTool = TaskTool.layer.pipe(Layer.provide(registry), Layer.provide(permission), Layer.provide(agents))
  // Same wiring as the production root (v2-runner-frame): one memoized slot + one SessionV2 build.
  const delegation = TaskTool.captureDelegationServiceLayer.pipe(
    Layer.provide(Delegation.delegationSlotLayer),
    Layer.provide(coreStack),
  )
  return Layer.mergeAll(coreStack, registry, permission, agents, taskTool, delegation, Delegation.delegationSlotLayer)
}

const it = testEffect(stackOver(Database.layerFromPath(":memory:")))

const services = Effect.gen(function* () {
  return {
    db: (yield* Database.Service).db,
    events: yield* EventV2.Service,
    sessions: yield* SessionV2.Service,
    registry: yield* ToolRegistry.Service,
    agents: yield* AgentV2.Service,
  }
})

// "general" keeps Info.empty defaults (no permission rules ⇒ write-capable ⇒ isolated worktree);
// "explore" is wholly denied ⇒ shared workspace.
const registerAgents = Effect.gen(function* () {
  const agents = yield* AgentV2.Service
  yield* agents.update((editor) => {
    editor.update(AgentV2.ID.make("general"), () => {})
    editor.update(AgentV2.ID.make("explore"), (draft) => {
      draft.permissions = [{ action: "*", resource: "*", effect: "deny" }]
    })
  })
})

const gitIn = (cwd: string, args: string[]) =>
  Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" })

const makeRepo = async (root: string) => {
  await fs.mkdir(root, { recursive: true })
  expectExit0(gitIn(root, ["init", "-b", "main"]), "git init")
  gitIn(root, ["config", "user.email", "test@deepagent.local"])
  gitIn(root, ["config", "user.name", "DeepAgent Test"])
  await fs.writeFile(path.join(root, "README.md"), "# fixture repo\n")
  expectExit0(gitIn(root, ["add", "-A"]), "git add")
  expectExit0(gitIn(root, ["commit", "-m", "init"]), "git commit")
  return fs.realpath(root)
}

function expectExit0(proc: ReturnType<typeof gitIn>, what: string) {
  if (proc.exitCode !== 0) throw new Error(`${what} failed: ${proc.stderr.toString()}`)
}

const specFor = (
  parentSessionID: SessionSchema.ID,
  toolCallID: string,
  directory: string,
  fileScope?: readonly string[],
) => ({
  parentSessionID,
  parentMessageID: SessionMessage.ID.make(`msg_parent_${toolCallID}`),
  toolCallID,
  deliveryMode: "foreground" as const,
  prompt: new Prompt({ text: "Do the isolated work." }),
  agent: "general",
  ...(fileScope === undefined ? {} : { fileScope }),
  child: {
    title: `task: ${toolCallID}`,
    location: { directory: AbsolutePath.make(directory) },
    permissions: [] as const,
    workspace: { mode: "worktree" as const },
  },
})

const call = (name: string, input: unknown, sessionID: SessionSchema.ID, id: string) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name, input },
})

const taskCall = (
  input: Record<string, unknown>,
  sessionID: SessionSchema.ID,
  id = `call-task-${crypto.randomUUID().slice(0, 8)}`,
) => call("task", input, sessionID, id)

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

const insertMessage = (db: Database.Interface["db"], sessionID: SessionSchema.ID, seq: number, plain: unknown) => {
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

const runRow = (db: Database.Interface["db"], runID: string) =>
  db
    .select()
    .from(TaskRunTable)
    .where(eq(TaskRunTable.run_id, runID))
    .get()
    .pipe(Effect.orDie)

const textOf = (result: { readonly type: string; readonly value?: unknown }) => String(result.value)

/** The settlement's output is the LLM ToolOutput envelope; the tool's encoded Output is its structured half. */
const outputOf = (settlement: { readonly output?: unknown }) =>
  (settlement.output as { structured: unknown }).structured as TaskTool.Output

describe("task tool run visibility (WS4b-S2.1)", () => {
  it.effect("a completed isolated run reports branch + worktree state and the branch line", () =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() => makeRepo(path.join(tmpRoot(), "repo")))
      const { db, sessions, registry } = yield* services
      yield* registerAgents
      const parent = yield* sessions.create({ location: { directory: AbsolutePath.make(repo) } })

      const settlement = yield* settleTool(
        registry,
        taskCall(
          { description: "isolated write", prompt: "do the write work", subagent_type: "general" },
          parent.id,
        ),
      )
      expect(settlement.result.type).toBe("text")
      const output = outputOf(settlement)
      expect(output.run?.agent_type).toBe("general")
      expect(output.run?.workspace_mode).toBe("worktree")
      expect(output.run?.branch).toMatch(/^deepagent-code\/task-/)
      expect(output.run?.worktree_state).toBe("removed")

      const text = textOf(settlement.result)
      expect(text).toContain(
        `Write-type subagent output is on branch \`${output.run!.branch}\`; finalize with pr_finalize, inspect with task_read.`,
      )
      expect(text).toContain(`task_id: "${output.task_id}"`)

      // The completed run released its worktree: the durable row agrees with the branch pointer.
      const rows = yield* db
        .select()
        .from(TaskRunTable)
        .where(eq(TaskRunTable.child_session_id, SessionSchema.ID.make(output.task_id)))
        .all()
        .pipe(Effect.orDie)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.state).toBe("completed")
      expect(rows[0]!.worktree_branch).toBe(output.run!.branch ?? null)
    }),
  )

  // C-P2-08 honest resume fence: a write-isolated child lives in its run-owned worktree, so a
  // resume-by-task_id after that worktree was removed or reclaimed must refuse with the real
  // reason instead of running the child against a dead root.
  it.effect("resume-by-task_id refuses honestly when the isolated worktree is gone (removed / reclaimed)", () =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() => makeRepo(path.join(tmpRoot(), "repo")))
      const { db, sessions, registry } = yield* services
      yield* registerAgents
      const parent = yield* sessions.create({ location: { directory: AbsolutePath.make(repo) } })

      const settlement = yield* settleTool(
        registry,
        taskCall(
          { description: "isolated write", prompt: "do the write work", subagent_type: "general" },
          parent.id,
        ),
      )
      const childID = outputOf(settlement).task_id

      // After the completed run's release the worktree is gone: the resume names the removal.
      const removed = yield* executeTool(
        registry,
        taskCall({ description: "resume", prompt: "continue", subagent_type: "general", task_id: childID }, parent.id),
      )
      expect(removed.type).toBe("error")
      expect(String(removed.value)).toContain(`Cannot resume task "${childID}": its isolated worktree was already removed`)

      // After a stale-retention reclaim (C-P2-08) the resume names the reclaim.
      yield* db
        .update(TaskRunTable)
        .set({ worktree_state: "reclaimed" })
        .where(eq(TaskRunTable.child_session_id, SessionSchema.ID.make(childID)))
        .run()
        .pipe(Effect.orDie)
      const reclaimed = yield* executeTool(
        registry,
        taskCall({ description: "resume", prompt: "continue", subagent_type: "general", task_id: childID }, parent.id, "call-resume-reclaimed"),
      )
      expect(reclaimed.type).toBe("error")
      expect(String(reclaimed.value)).toContain(`its retained worktree was reclaimed after the retention grace period`)
    }),
  )
})

describe("task tool bounded result injection (WS4b-S3)", () => {
  const priorCap = process.env.DEEPAGENT_CODE_SUBAGENT_OUTPUT_MAX_CHARS
  afterEach(() => {
    if (priorCap === undefined) delete process.env.DEEPAGENT_CODE_SUBAGENT_OUTPUT_MAX_CHARS
    else process.env.DEEPAGENT_CODE_SUBAGENT_OUTPUT_MAX_CHARS = priorCap
  })

  const fabricateFinalTurn = (db: Database.Interface["db"], text: string) => {
    resumeHook = (sessionID) =>
      insertMessage(db, sessionID, 1, {
        id: `msg_final_${text.length}`,
        type: "assistant",
        agent: "explore",
        model: { id: "m", providerID: "p" },
        content: [{ type: "text", id: "part_final", text }],
        time: { created: 1_000 },
      }).pipe(Effect.asVoid)
  }

  it.effect("keeps the tail of an over-long result and points at task_read with the branch", () =>
    Effect.gen(function* () {
      process.env.DEEPAGENT_CODE_SUBAGENT_OUTPUT_MAX_CHARS = "100"
      const { db, sessions, registry } = yield* services
      yield* registerAgents
      const parent = yield* sessions.create({ location: { directory: AbsolutePath.make("/tmp") } })

      const longText = `${"H".repeat(400)}${"T".repeat(100)}`
      fabricateFinalTurn(db, longText)
      const settlement = yield* settleTool(
        registry,
        taskCall(
          { description: "long shared research", prompt: "research verbosely", subagent_type: "explore" },
          parent.id,
        ),
      )
      expect(settlement.result.type).toBe("text")
      const output = outputOf(settlement)
      expect(output.text.startsWith("T".repeat(100))).toBe(true)
      expect(output.text).not.toContain("HHHH")
      expect(output.text).toContain(
        `Output truncated (500 chars). Full transcript: task_read(task_id="${output.task_id}"). Branch: n/a`,
      )
      // Codepoint accounting: 100 kept chars + the note.
      expect(Array.from(output.text).length).toBeLessThan(400)
    }),
  )

  it.effect("passes a short result through untouched", () =>
    Effect.gen(function* () {
      process.env.DEEPAGENT_CODE_SUBAGENT_OUTPUT_MAX_CHARS = "100"
      const { db, sessions, registry } = yield* services
      yield* registerAgents
      const parent = yield* sessions.create({ location: { directory: AbsolutePath.make("/tmp") } })

      fabricateFinalTurn(db, "short answer")
      const settlement = yield* settleTool(
        registry,
        taskCall(
          { description: "short shared research", prompt: "research briefly", subagent_type: "explore" },
          parent.id,
        ),
      )
      expect(settlement.result.type).toBe("text")
      const output = outputOf(settlement)
      expect(output.text).toBe("short answer")
    }),
  )
})

describe("task tool file_scope overlap warnings (WS4b-S4)", () => {
  it.effect("warns on overlapping active write siblings; disjoint and undeclared scopes stay quiet", () =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() => makeRepo(path.join(tmpRoot(), "repo")))
      const { db, events, sessions, registry } = yield* services
      yield* registerAgents
      const parent = yield* sessions.create({ location: { directory: AbsolutePath.make(repo) } })

      // An ACTIVE (admitted, never executed) write sibling declaring src/a.ts.
      const sibling = yield* TaskRunAuthority.submit(
        db,
        events,
        sessions,
        specFor(parent.id, "call-sibling-1", repo, ["src/a.ts"]),
      )

      const overlapped = yield* settleTool(
        registry,
        taskCall(
          {
            description: "overlapping write",
            prompt: "touch the same file",
            subagent_type: "general",
            file_scope: ["src/a.ts"],
          },
          parent.id,
        ),
      )
      expect(overlapped.result.type).toBe("text")
      const overlapOutput = outputOf(overlapped)
      expect(overlapOutput.warnings).toHaveLength(1)
      expect(overlapOutput.warnings![0]).toContain(
        `Scope overlaps with active task ${sibling.run.childSessionID} (src/a.ts)`,
      )
      expect(textOf(overlapped.result)).toContain("Scope overlaps with active task")

      const disjoint = yield* settleTool(
        registry,
        taskCall(
          {
            description: "disjoint write",
            prompt: "touch another file",
            subagent_type: "general",
            file_scope: ["src/b.ts"],
          },
          parent.id,
        ),
      )
      expect(disjoint.result.type).toBe("text")
      expect(outputOf(disjoint).warnings).toBeUndefined()

      const undeclared = yield* settleTool(
        registry,
        taskCall(
          { description: "undeclared write", prompt: "touch unknown files", subagent_type: "general" },
          parent.id,
        ),
      )
      expect(undeclared.result.type).toBe("text")
      expect(outputOf(undeclared).warnings).toBeUndefined()
    }),
  )

  it.effect("records the declared file scope on the durable run execution spec", () =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() => makeRepo(path.join(tmpRoot(), "repo")))
      const { db, sessions, registry } = yield* services
      yield* registerAgents
      const parent = yield* sessions.create({ location: { directory: AbsolutePath.make(repo) } })

      const settlement = yield* settleTool(
        registry,
        taskCall(
          {
            description: "scoped write",
            prompt: "touch declared files",
            subagent_type: "general",
            file_scope: ["src/c.ts", "src/d.ts"],
          },
          parent.id,
        ),
      )
      expect(settlement.result.type).toBe("text")
      const output = outputOf(settlement)
      const row = yield* db
        .select()
        .from(TaskRunTable)
        .where(eq(TaskRunTable.child_session_id, SessionSchema.ID.make(output.task_id)))
        .get()
        .pipe(Effect.orDie)
      expect(row?.execution_spec).toMatchObject({ fileScope: ["src/c.ts", "src/d.ts"] })
    }),
  )
})

describe("task tool structured-output degraded settlement (bug-V2.0-003)", () => {
  // Exhausting BOTH bounded finalizer attempts must settle DEGRADED (e829ebf5a parity) — a
  // receipt-stamped {_degraded,_reason,_attempts,_raw} payload to the parent plus a durable
  // validation_failed evidence row — never a tool failure that strands the parent turn.
  const fabricateTurns = (db: Database.Interface["db"], text: string) => {
    let seq = 0
    resumeHook = (sessionID) =>
      insertMessage(db, sessionID, ++seq, {
        id: `msg_degraded_turn_${seq}`,
        type: "assistant",
        agent: "explore",
        model: { id: "m", providerID: "p" },
        content: [{ type: "text", id: `part_degraded_turn_${seq}`, text }],
        time: { created: 1_000 },
      }).pipe(Effect.asVoid)
  }

  const schemaCall = (sessionID: SessionSchema.ID) =>
    taskCall(
      {
        description: "degraded structured output",
        prompt: "research the module",
        subagent_type: "explore",
        output_schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] },
      },
      sessionID,
    )

  const evidenceOf = (db: Database.Interface["db"], runID: string) =>
    db
      .select()
      .from(V2StructuredOutputEvidenceTable)
      .where(eq(V2StructuredOutputEvidenceTable.run_id, runID))
      .get()
      .pipe(Effect.orDie)

  it.effect("two schema-invalid finalizer attempts degrade with a receipt-stamped payload and durable evidence", () =>
    Effect.gen(function* () {
      const { db, sessions, registry } = yield* services
      yield* registerAgents
      const parent = yield* sessions.create({ location: { directory: AbsolutePath.make("/tmp") } })

      fabricateTurns(db, `{"answer":"not-a-number"}`)
      const settlement = yield* settleTool(registry, schemaCall(parent.id))

      expect(settlement.result.type).toBe("text")
      const output = outputOf(settlement)
      const payload = JSON.parse(output.text)
      expect(payload).toMatchObject({ _degraded: true, _reason: "structured_output_invalid", _attempts: 2 })
      expect(payload._raw).toBe(`{"answer":"not-a-number"}`)

      const run = yield* db
        .select()
        .from(TaskRunTable)
        .where(eq(TaskRunTable.child_session_id, SessionSchema.ID.make(output.task_id)))
        .get()
        .pipe(Effect.orDie)
      expect(run?.state).toBe("completed")

      // Attempt budget unchanged: one durable first input plus exactly two finalizer follow-ups.
      const childInputs = yield* db
        .select()
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, SessionSchema.ID.make(output.task_id)))
        .all()
        .pipe(Effect.orDie)
      expect(childInputs).toHaveLength(3)

      const evidence = yield* evidenceOf(db, run!.run_id)
      expect(evidence?.validation_outcome).toBe("validation_failed")
      expect(evidence?.schema_name).toBe("inline")
      expect(evidence?.raw_output).toBe(output.text)
      expect(evidence?.owner_token).toBe(`core-v2-finalizer:${run!.child_session_id}`)
    }),
  )

  it.effect("finalizer turns without any JSON value degrade with structured_output_missing", () =>
    Effect.gen(function* () {
      const { db, sessions, registry } = yield* services
      yield* registerAgents
      const parent = yield* sessions.create({ location: { directory: AbsolutePath.make("/tmp") } })

      fabricateTurns(db, "Prose only, no JSON value.")
      const settlement = yield* settleTool(registry, schemaCall(parent.id))

      expect(settlement.result.type).toBe("text")
      const output = outputOf(settlement)
      const payload = JSON.parse(output.text)
      expect(payload).toMatchObject({ _degraded: true, _reason: "structured_output_missing", _attempts: 2 })
      expect(payload._raw).toBe("Prose only, no JSON value.")

      const run = yield* db
        .select()
        .from(TaskRunTable)
        .where(eq(TaskRunTable.child_session_id, SessionSchema.ID.make(output.task_id)))
        .get()
        .pipe(Effect.orDie)
      const evidence = yield* evidenceOf(db, run!.run_id)
      expect(evidence?.validation_outcome).toBe("validation_failed")
      expect(evidence?.raw_output).toBe(output.text)
    }),
  )

  it.effect("a validated finalizer candidate seals evidence bound to the child's answer message", () =>
    Effect.gen(function* () {
      const { db, sessions, registry } = yield* services
      yield* registerAgents
      const parent = yield* sessions.create({ location: { directory: AbsolutePath.make("/tmp") } })

      // The research turn and the finalizer turn both produce the schema-valid candidate.
      fabricateTurns(db, `{"answer":42}`)
      const settlement = yield* settleTool(registry, schemaCall(parent.id))

      expect(settlement.result.type).toBe("text")
      const output = outputOf(settlement)
      expect(output.text).toBe(`{"answer":42}`)

      const run = yield* db
        .select()
        .from(TaskRunTable)
        .where(eq(TaskRunTable.child_session_id, SessionSchema.ID.make(output.task_id)))
        .get()
        .pipe(Effect.orDie)
      expect(run?.state).toBe("completed")

      // Regression (live subagent-foreground): the finalizer's evidence input must carry the
      // authority's `outputMessageId` field — a misnamed spread silently dropped the binding and
      // the insert guard aborted every validated record with a raw constraint error.
      const evidence = yield* evidenceOf(db, run!.run_id)
      expect(evidence?.validation_outcome).toBe("validated")
      expect(evidence?.output_message_id).toBe("msg_degraded_turn_2")
      expect(evidence?.raw_output).toBe(`{"answer":42}`)
      expect(evidence?.owner_token).toBe(`core-v2-finalizer:${run!.child_session_id}`)
    }),
  )
})

describe("task tool timeout notice (WS4b-S2.3)", () => {
  test("names the retained branch, the resume pointer, and the task_close cleanup path", () => {
    const text = TaskTool.timeoutNoticeText({ timeoutMs: 1_234, childID: "ses_x", branch: "deepagent-code/task-abc" })
    expect(text).toContain("timed out after 1234ms")
    expect(text).toContain("worktree retained on branch deepagent-code/task-abc")
    expect(text).toContain('resume with task_id "ses_x" to continue')
    expect(text).toContain("task_close")

    const branchless = TaskTool.timeoutNoticeText({ timeoutMs: 5, childID: "ses_y" })
    expect(branchless).toContain("partial work retained")
    expect(branchless).not.toContain("branch")
  })
})
