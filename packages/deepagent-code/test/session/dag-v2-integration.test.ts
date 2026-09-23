import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Context, DateTime, Duration, Effect, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { AgentExecution } from "@deepagent-code/core/deepagent/agent-execution"
import { ApprovalQueue } from "@deepagent-code/core/deepagent/approval-queue"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { EventAdmission } from "@deepagent-code/core/deepagent/event-admission"
import { TaskPartitioner } from "@deepagent-code/core/deepagent/task-partitioner"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionMessage } from "@deepagent-code/core/session/message"
import type { InstanceStore } from "@/project/instance-store"
import { makeEventTurnRunnerV2 } from "@/session/event-turn-runner"
import { MultiAgentRuntime } from "@/session/multi-agent-runtime"
import { makeV2AdmissionBridge } from "@/session/v2-admission-bridge"

const git = async (args: string[], cwd: string) => {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, code] = await Promise.all([new Response(process.stdout).text(), process.exited])
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}`)
  return stdout.trim()
}

const fakeSessions = (options: { parallel?: boolean } = {}) => {
  const sessions = new Map<
    string,
    {
      id: SessionV2.ID
      parentID?: SessionV2.ID
      location: { directory: string }
      permissions: []
      metadata?: { taskID?: string }
    }
  >()
  const messages = new Map<string, SessionMessage.Message[]>()
  const prompts: { sessionID: string; delivery?: string; resume?: boolean }[] = []
  const turns: { taskID: string; directory: string; sawFix: boolean }[] = []
  const parallelEvidence = { started: [] as string[], overlap: false }
  let releaseParallel = () => {}
  const bothStarted = new Promise<void>((resolve) => {
    releaseParallel = resolve
  })
  const sessionsService = {
    get: (id: SessionV2.ID) => {
      const found = sessions.get(id)
      return found ? Effect.succeed(found) : Effect.fail(new Error("not found"))
    },
    create: (input: {
      id: SessionV2.ID
      parentID?: SessionV2.ID
      location: { directory: string }
      metadata?: { taskID?: string }
    }) =>
      Effect.sync(() => {
        const found = sessions.get(input.id)
        if (found) return found
        const created = { ...input, permissions: [] as [] }
        sessions.set(input.id, created)
        return created
      }),
    messages: ({ sessionID }: { sessionID: SessionV2.ID }) => Effect.succeed(messages.get(sessionID) ?? []),
    prompt: (input: { id: SessionMessage.ID; sessionID: SessionV2.ID; delivery?: string; resume?: boolean }) =>
      Effect.sync(() => {
        prompts.push({ sessionID: input.sessionID, delivery: input.delivery, resume: input.resume })
        messages.set(input.sessionID, [
          ...(messages.get(input.sessionID) ?? []),
          { id: input.id, type: "user", time: { created: DateTime.makeUnsafe(1) } } as SessionMessage.Message,
        ])
        return { id: input.id }
      }),
    resume: (sessionID: SessionV2.ID) =>
      Effect.tryPromise({
        try: async () => {
          const child = sessions.get(sessionID)
          if (!child?.metadata?.taskID) throw new Error("missing child task")
          const testTurn = child.metadata.taskID.endsWith(":1")
          const sawFix = await fs.exists(path.join(child.location.directory, "fix.txt"))
          if (options.parallel) {
            parallelEvidence.started.push(child.location.directory)
            if (parallelEvidence.started.length === 2) {
              parallelEvidence.overlap = (
                await Promise.all(parallelEvidence.started.map((directory) => fs.exists(directory)))
              ).every(Boolean)
              releaseParallel()
            }
            await bothStarted
          }
          if (!options.parallel && testTurn && !sawFix) throw new Error("test turn did not inherit the fix branch")
          await fs.writeFile(
            path.join(
              child.location.directory,
              options.parallel ? `parallel-${testTurn ? 1 : 0}.txt` : testTurn ? "test.txt" : "fix.txt",
            ),
            "done\n",
          )
          turns.push({ taskID: child.metadata.taskID, directory: child.location.directory, sawFix })
          messages.set(sessionID, [
            ...(messages.get(sessionID) ?? []),
            {
              id: SessionMessage.ID.make(`msg_reply_${turns.length}`),
              type: "assistant",
              time: { created: DateTime.makeUnsafe(2), completed: DateTime.makeUnsafe(3) },
              finish: "stop",
              content: [{ type: "text", text: "done" }],
              tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
              cost: 0,
            } as unknown as SessionMessage.Message,
          ])
        },
        catch: () => new Error("fake provider turn failed"),
      }),
    interrupt: () => Effect.void,
  } as unknown as SessionV2.Interface
  const instanceStore = {
    load: ({ directory }: { directory: string }) => Effect.succeed({ directory }),
  } as unknown as InstanceStore.Interface
  return { sessionsService, instanceStore, prompts, turns, parallelEvidence }
}

describe("V2 event DAG with real git worktrees", () => {
  test("disjoint write scopes run concurrently in two real worktrees", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "dag-v2-parallel-"))
    try {
      await git(["init", "-b", "main"], repo)
      await git(["config", "user.email", "test@test.dev"], repo)
      await git(["config", "user.name", "test"], repo)
      await fs.writeFile(path.join(repo, "seed.txt"), "seed\n")
      await git(["add", "-A"], repo)
      await git(["commit", "--no-verify", "-m", "seed"], repo)
      const fake = fakeSessions({ parallel: true })
      const database = Database.layerFromPath(":memory:")
      const core = Layer.mergeAll(DeepAgentEventBus.layer, ApprovalQueue.layer, AgentExecution.layer).pipe(
        Layer.provideMerge(database),
      )
      const agents = Layer.succeed(AgentListProviderService, {
        listAgents: () =>
          Effect.succeed([
            {
              id: "fixer",
              name: "fixer",
              displayName: "fixer",
              visible: true,
              capabilities: ["code_edit"],
              autonomy: "level_2" as const,
            },
          ]),
        findByTrigger: () => Effect.succeed([]),
        findByCapability: () => Effect.succeed([]),
      })
      const runtime = Layer.unwrap(
        Effect.gen(function* () {
          const execution = yield* AgentExecution.Service
          return MultiAgentRuntime.layerWith({
            runner: makeEventTurnRunnerV2({ sessions: fake.sessionsService, instanceStore: fake.instanceStore }),
            execution,
            dagCoordination: true,
            partition: (event) => ({
              event,
              subtasks: [0, 1].map((index) => ({
                id: `${event.id}:${index}`,
                capability: "code_edit",
                intent: `edit independent file ${index}`,
                dependsOn: [],
                fileScope: [`parallel-${index}.txt`],
                requiredAutonomy: "level_2" as const,
              })),
            }),
          })
        }),
      ).pipe(Layer.provide(core), Layer.provide(agents))
      const refs = await Effect.runPromise(
        Effect.gen(function* () {
          const context = yield* Layer.build(Layer.mergeAll(runtime, core))
          const service = Context.get(context, MultiAgentRuntime.Service)
          const execution = Context.get(context, AgentExecution.Service)
          const event: DeepAgentEvent.Event = {
            id: DeepAgentEvent.ID.create(2_000),
            type: "test.parallel",
            source: "schedule",
            workspaceID: "wrk_dag_parallel",
            idempotencyKey: "parallel-once",
            priority: "normal",
            createdAt: 2_000,
            payload: { directory: repo },
          }
          const summary = yield* service.coordinate(event)
          expect(summary.outcomes.map((outcome) => outcome.status)).toEqual(["completed", "completed"])
          return yield* Effect.forEach([0, 1], (index) =>
            execution.get({ workspaceID: event.workspaceID, eventID: event.id, taskID: `${event.id}:${index}` }),
          )
        }).pipe(Effect.scoped, Effect.timeout(Duration.seconds(5))),
      )
      expect(fake.parallelEvidence.overlap).toBe(true)
      expect(new Set(fake.parallelEvidence.started).size).toBe(2)
      expect(fake.turns).toHaveLength(2)
      expect(fake.prompts.every((prompt) => prompt.resume === false)).toBe(true)
      expect(await Promise.all(fake.parallelEvidence.started.map((directory) => fs.exists(directory)))).toEqual([
        false,
        false,
      ])
      expect(refs.every((record) => record?.status === "completed" && record.continuationRef)).toBe(true)
      if (refs[0]?.continuationRef && refs[1]?.continuationRef) {
        expect(await git(["show", `${refs[0].continuationRef}:parallel-0.txt`], repo)).toBe("done")
        expect(await git(["show", `${refs[1].continuationRef}:parallel-1.txt`], repo)).toBe("done")
      }
    } finally {
      await fs.rm(repo, { recursive: true, force: true })
    }
  })

  test("repair fix then test inherits the first committed ref and replays without another turn", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "dag-v2-integration-"))
    try {
      await git(["init", "-b", "main"], repo)
      await git(["config", "user.email", "test@test.dev"], repo)
      await git(["config", "user.name", "test"], repo)
      await fs.writeFile(path.join(repo, "seed.txt"), "seed\n")
      await git(["add", "-A"], repo)
      await git(["commit", "--no-verify", "-m", "seed"], repo)
      const fake = fakeSessions()
      const database = Database.layerFromPath(":memory:")
      const core = Layer.mergeAll(DeepAgentEventBus.layer, ApprovalQueue.layer, AgentExecution.layer).pipe(
        Layer.provideMerge(database),
      )
      const agents = Layer.succeed(AgentListProviderService, {
        listAgents: () =>
          Effect.succeed([
            {
              id: "fixer",
              name: "fixer",
              displayName: "fixer",
              visible: true,
              capabilities: ["code_edit", "test_run"],
              autonomy: "level_2" as const,
            },
          ]),
        findByTrigger: () => Effect.succeed([]),
        findByCapability: () => Effect.succeed([]),
      })
      const runtime = Layer.unwrap(
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const execution = yield* AgentExecution.Service
          return MultiAgentRuntime.layerWith({
            runner: makeEventTurnRunnerV2({ sessions: fake.sessionsService, instanceStore: fake.instanceStore }),
            execution,
            dagCoordination: true,
            eventV2Admission: makeV2AdmissionBridge({ db, v2Session: fake.sessionsService }),
          })
        }),
      ).pipe(Layer.provide(core), Layer.provide(agents))
      const event: DeepAgentEvent.Event = {
        id: DeepAgentEvent.ID.create(1_000),
        type: "ci.repair.requested",
        source: "schedule",
        workspaceID: "wrk_dag_integration",
        idempotencyKey: "repair-once",
        priority: "normal",
        createdAt: 1_000,
        payload: { directory: repo, repo: "fixture/repo" },
      }
      const refs: { fix?: string; test?: string } = {}
      await Effect.runPromise(
        Effect.gen(function* () {
          const context = yield* Layer.build(Layer.mergeAll(runtime, core))
          const service = Context.get(context, MultiAgentRuntime.Service)
          const execution = Context.get(context, AgentExecution.Service)
          const bus = Context.get(context, DeepAgentEventBus.Service)
          const db = Context.get(context, Database.Service).db
          const request = { event, priority: event.priority, targets: [] }
          yield* service.dispatch(request)
          const tasks = TaskPartitioner.partition(event, { stableIDPrefix: event.id }).subtasks
          const fix = yield* execution.get({ workspaceID: event.workspaceID, eventID: event.id, taskID: tasks[0].id })
          const verify = yield* execution.get({
            workspaceID: event.workspaceID,
            eventID: event.id,
            taskID: tasks[1].id,
          })
          expect(fix?.status).toBe("completed")
          expect(verify?.status).toBe("completed")
          expect(fix?.continuationRef).toBeDefined()
          expect(verify?.continuationRef).toBeDefined()
          refs.fix = fix?.continuationRef
          refs.test = verify?.continuationRef
          expect((yield* EventAdmission.forSession(db, MultiAgentRuntime.parentSessionIDFor(event.id))).length).toBe(1)
          expect(
            (yield* bus.recentByType({ type: "agent.task.completed", now: Date.now(), windowMs: 60_000 })).length,
          ).toBe(2)
          yield* service.dispatch(request)
          expect(fake.turns).toHaveLength(2)
          expect(fake.prompts).toHaveLength(2)
          expect((yield* EventAdmission.forSession(db, MultiAgentRuntime.parentSessionIDFor(event.id))).length).toBe(1)
          expect(fake.prompts.every((prompt) => prompt.delivery === "queue" && prompt.resume === false)).toBe(true)
        }).pipe(Effect.scoped),
      )
      expect(fake.turns).toHaveLength(2)
      expect(fake.turns[0].sawFix).toBe(false)
      expect(fake.turns[1].sawFix).toBe(true)
      expect(fake.turns[0].directory).not.toBe(fake.turns[1].directory)
      expect(await fs.exists(fake.turns[0].directory)).toBe(false)
      expect(await fs.exists(fake.turns[1].directory)).toBe(false)
      expect(refs.fix).not.toBe(refs.test)
      if (refs.fix && refs.test) {
        expect(await git(["show", `${refs.test}:fix.txt`], repo)).toBe("done")
        expect(await git(["show", `${refs.test}:test.txt`], repo)).toBe("done")
        expect(await git(["merge-base", "--is-ancestor", refs.fix, refs.test], repo)).toBe("")
      }
    } finally {
      await fs.rm(repo, { recursive: true, force: true })
    }
  })
})
