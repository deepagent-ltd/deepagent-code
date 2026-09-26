import { describe, expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import os from "node:os"
import { Context, DateTime, Deferred, Effect, Fiber, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { ProjectV2 } from "@deepagent-code/core/project"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { EventTaskWorkspaceTable, SessionInputTable, SessionMessageTable } from "@deepagent-code/core/session/sql"
import { SessionStore } from "@deepagent-code/core/session/store"
import { TaskWorkspace } from "@deepagent-code/core/session/task-workspace"
import type { InstanceStore } from "@/project/instance-store"
import { makeEventTurnRunnerV2 } from "../../src/session/event-turn-runner"
import type { SubagentTurnInput } from "../../src/session/goal-loop-wiring"

const input = (over: Partial<SubagentTurnInput> = {}): SubagentTurnInput => ({
  agentType: "auto",
  prompt: "Repair and verify the CI failure",
  workspaceID: "wrk_event",
  directory: path.resolve("event-workspace"),
  parentSessionID: "ses_v4_parent",
  eventID: "dae_event",
  taskID: "dae_event:fix",
  generation: 1,
  ...over,
})

const fakeServices = (options: { stall?: boolean; afterAdmission?: () => void } = {}) => {
  const sessions = new Map<
    string,
    { id: SessionV2.ID; parentID?: SessionV2.ID; location: { directory: string }; permissions: [] }
  >()
  const messages = new Map<string, SessionMessage.Message[]>()
  const prompts: { sessionID: string; id: string; text: string; delivery: string; resume: boolean }[] = []
  const drains: string[] = []
  const interrupts: string[] = []
  const instanceStore = {
    load: ({ directory }: { directory: string }) => Effect.succeed({ directory }),
  } as unknown as InstanceStore.Interface
  const v2Session = {
    get: (id: SessionV2.ID) => {
      const found = sessions.get(id)
      return found ? Effect.succeed(found) : Effect.fail(new Error("not found"))
    },
    create: (value: { id: SessionV2.ID; parentID?: SessionV2.ID; location: { directory: string } }) =>
      Effect.sync(() => {
        const found = sessions.get(value.id)
        if (found) return found
        const created = { id: value.id, parentID: value.parentID, location: value.location, permissions: [] as [] }
        sessions.set(value.id, created)
        return created
      }),
    messages: ({ sessionID }: { sessionID: SessionV2.ID }) => Effect.succeed(messages.get(sessionID) ?? []),
    prompt: (value: {
      sessionID: SessionV2.ID
      id: SessionMessage.ID
      prompt: { text: string }
      delivery: string
      resume: boolean
    }) =>
      Effect.sync(() => {
        prompts.push({
          sessionID: value.sessionID,
          id: value.id,
          text: value.prompt.text,
          delivery: value.delivery,
          resume: value.resume,
        })
        if (!messages.get(value.sessionID)?.some((message) => message.id === value.id))
          messages.set(value.sessionID, [
            ...(messages.get(value.sessionID) ?? []),
            { id: value.id, type: "user", time: { created: DateTime.makeUnsafe(1) } } as SessionMessage.Message,
          ])
        return { id: value.id }
      }).pipe(
        Effect.tap(() => Effect.sync(() => options.afterAdmission?.())),
        Effect.flatMap((result) => (options.afterAdmission ? Effect.never : Effect.succeed(result))),
      ),
    resume: (sessionID: SessionV2.ID) =>
      options.stall
        ? Effect.never
        : Effect.sync(() => {
            drains.push(sessionID)
            messages.set(sessionID, [
              ...(messages.get(sessionID) ?? []),
              {
                id: SessionMessage.ID.make(`msg_reply_${drains.length}`),
                type: "assistant",
                time: { created: DateTime.makeUnsafe(2), completed: DateTime.makeUnsafe(3) },
                finish: "stop",
                content: [{ type: "text", text: "repaired" }],
                tokens: { input: 12, output: 3, reasoning: 2, cache: { read: 0, write: 0 } },
                cost: 0.01,
              } as unknown as SessionMessage.Message,
            ])
          }),
    interrupt: (sessionID: SessionV2.ID) => Effect.sync(() => interrupts.push(sessionID)),
  } as unknown as SessionV2.Interface
  return { sessions, prompts, drains, interrupts, instanceStore, v2Session }
}

describe("V2 event turn runner", () => {
  test("a real V2 admit-only inbox survives a crash without provider work on DAG replay", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "event-turn-real-admission-"))
    try {
      const git = async (args: string[]) => {
        const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" })
        if (await proc.exited !== 0) throw new Error(`git ${args.join(" ")} failed`)
      }
      await git(["init", "-b", "main"])
      await git(["config", "user.email", "test@test.dev"])
      await git(["config", "user.name", "test"])
      await fs.writeFile(path.join(repo, "seed.txt"), "seed\n")
      await git(["add", "-A"])
      await git(["commit", "--no-verify", "-m", "seed"])
      const database = Database.layerFromPath(":memory:")
      const events = EventV2.layer.pipe(Layer.provide(database))
      const store = SessionStore.layer.pipe(Layer.provide(database))
      const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
      const projects = Layer.succeed(ProjectV2.Service, ProjectV2.Service.of({
        resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
        directories: () => Effect.succeed([]),
        commit: () => Effect.void,
      }))
      const resumes: string[] = []
      const execution = Layer.succeed(SessionExecution.Service, SessionExecution.Service.of({
        active: Effect.succeed(new Set()),
        resume: (sessionID) => Effect.sync(() => { resumes.push(sessionID) }),
        wake: () => Effect.void,
        interrupt: () => Effect.void,
        awaitIdle: () => Effect.void,
      }))
      const sessions = SessionV2.layer.pipe(
        Layer.provide(events), Layer.provide(database), Layer.provide(store),
        Layer.provide(projects), Layer.provide(execution),
      )
      await Effect.runPromise(Effect.gen(function* () {
        const context = yield* Layer.build(Layer.mergeAll(database, events, store, projector, projects, execution, sessions))
        const db = Context.get(context, Database.Service).db
        const real = Context.get(context, SessionV2.Service)
        const admitted = yield* Deferred.make<void>()
        const crashed = SessionV2.Service.of({
          ...real,
          prompt: (value) => real.prompt(value).pipe(
            Effect.tap(() => Deferred.succeed(admitted, undefined)),
            Effect.flatMap(() => Effect.never),
          ),
        })
        const attempt = input({ directory: repo, requiresWriteIsolation: true })
        const instanceStore = fakeServices().instanceStore
        const first = Effect.runFork(makeEventTurnRunnerV2({ sessions: crashed, instanceStore, db })(attempt))
        const boundary = yield* Effect.race(
          Deferred.await(admitted).pipe(Effect.as("admitted")),
          Fiber.await(first).pipe(Effect.map((exit) => JSON.stringify(exit))),
        )
        expect(boundary).toBe("admitted")
        yield* Fiber.interrupt(first)
        expect(resumes).toEqual([])
        expect(yield* db.select().from(SessionInputTable).all()).toHaveLength(1)
        expect(yield* db.select().from(SessionMessageTable).all()).toHaveLength(0)
        const receipts = yield* db.select().from(EventTaskWorkspaceTable).all()
        expect(receipts).toHaveLength(1)
        expect(receipts[0]?.state).toBe("retained")

        const replay = yield* makeEventTurnRunnerV2({ sessions: real, instanceStore, db })(attempt)
        expect(replay).toMatchObject({ ok: false, reason: "admission_recovery_required" })
        expect(resumes).toEqual([])
        const inputs = yield* db.select().from(SessionInputTable).all()
        expect(inputs).toHaveLength(1)
        expect(yield* db.select().from(SessionMessageTable).all()).toHaveLength(0)
        expect((yield* db.select().from(EventTaskWorkspaceTable).all())[0]?.state).toBe("retained")
        expect((yield* Effect.promise(() => fs.stat(receipts[0]!.directory))).isDirectory()).toBe(true)
        const exactRetry = yield* real.prompt({
          id: SessionMessage.ID.make(inputs[0]!.id),
          sessionID: SessionV2.ID.make(inputs[0]!.session_id),
          prompt: new Prompt({ text: attempt.prompt }),
          delivery: "queue",
          resume: false,
        })
        expect(exactRetry.id).toBe(inputs[0]!.id)
        expect(yield* db.select().from(SessionInputTable).all()).toHaveLength(1)
        expect(resumes).toEqual([])
        // AgentExecution.claim increments generation after a failed/expired lease. That new
        // identity must not bypass the previous generation's admitted, unpromoted inbox row.
        const nextGeneration = yield* makeEventTurnRunnerV2({ sessions: real, instanceStore, db })({
          ...attempt,
          generation: attempt.generation! + 1,
        })
        expect(resumes).toEqual([])
        expect(nextGeneration).toMatchObject({ ok: false, reason: "admission_recovery_required" })
        expect(yield* db.select().from(SessionInputTable).all()).toHaveLength(1)
        expect((yield* TaskWorkspace.reclaimStale(db, {
          now: Date.now() + TaskWorkspace.DEFAULT_WORKTREE_RETENTION_MS + 1_000,
        })).reclaimed).toBe(1)
      }).pipe(Effect.scoped))
    } finally {
      await fs.rm(repo, { recursive: true, force: true })
    }
  })

  test("durable worktree replay after admit-only interruption never starts provider work", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "event-turn-durable-crash-"))
    try {
      const git = async (args: string[]) => {
        const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" })
        if (await proc.exited !== 0) throw new Error(`git ${args.join(" ")} failed`)
      }
      await git(["init", "-b", "main"])
      await git(["config", "user.email", "test@test.dev"])
      await git(["config", "user.name", "test"])
      await fs.writeFile(path.join(repo, "seed.txt"), "seed\n")
      await git(["add", "-A"])
      await git(["commit", "--no-verify", "-m", "seed"])
      let admitted: (() => void) | undefined
      const admission = new Promise<void>((resolve) => { admitted = resolve })
      const fake = fakeServices({ afterAdmission: () => admitted?.() })
      await Effect.runPromise(Effect.gen(function* () {
        const context = yield* Layer.build(Database.layerFromPath(":memory:"))
        const db = Context.get(context, Database.Service).db
        const run = makeEventTurnRunnerV2({ sessions: fake.v2Session, instanceStore: fake.instanceStore, db })
        const attempt = input({ directory: repo, requiresWriteIsolation: true })
        const fiber = Effect.runFork(run(attempt))
        yield* Effect.promise(() => admission)
        yield* Fiber.interrupt(fiber)
        const receipts = yield* db.select().from(EventTaskWorkspaceTable).all()
        expect(receipts).toHaveLength(1)
        expect(receipts[0]?.state).toBe("retained")
        const replay = yield* run(attempt)
        expect(replay).toMatchObject({ ok: false, reason: "admission_recovery_required" })
        expect(fake.prompts).toHaveLength(1)
        expect(fake.drains).toEqual([])
        expect((yield* TaskWorkspace.reclaimStale(db, {
          now: Date.now() + TaskWorkspace.DEFAULT_WORKTREE_RETENTION_MS + 1_000,
        })).reclaimed).toBe(1)
      }).pipe(Effect.scoped))
    } finally {
      await fs.rm(repo, { recursive: true, force: true })
    }
  })

  test("a crash after durable admission but before join leaves provider calls at zero", async () => {
    let admitted: (() => void) | undefined
    const admission = new Promise<void>((resolve) => {
      admitted = resolve
    })
    const fake = fakeServices({ afterAdmission: () => admitted?.() })
    const run = makeEventTurnRunnerV2({ sessions: fake.v2Session, instanceStore: fake.instanceStore })
    const fiber = Effect.runFork(run(input()))
    await admission
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(fake.prompts).toHaveLength(1)
    expect(fake.prompts[0]).toMatchObject({ resume: false, delivery: "queue" })
    expect(fake.drains).toEqual([])
    expect(fake.sessions.has(fake.prompts[0].sessionID)).toBe(true)
  })

  test("replay reconciles one durable prompt identity and does not drive the provider twice", async () => {
    const fake = fakeServices()
    const run = makeEventTurnRunnerV2({ sessions: fake.v2Session, instanceStore: fake.instanceStore })
    const first = await Effect.runPromise(run(input()))
    const replay = await Effect.runPromise(run(input()))
    expect(first).toMatchObject({ ok: true, text: "repaired", tokensUsed: 17, cost: 0.01 })
    expect(replay).toEqual(first)
    expect(fake.prompts).toHaveLength(2)
    expect(fake.prompts[0]).toEqual(fake.prompts[1])
    expect(fake.prompts[0]).toMatchObject({ delivery: "queue", resume: false })
    expect(fake.drains).toHaveLength(1)
    expect(fake.sessions.get(first.sessionID ?? "")?.parentID).toBe(SessionV2.ID.make("ses_v4_parent"))
  })

  test("a write turn without a resolvable directory fails before admitting a prompt", async () => {
    const fake = fakeServices()
    const result = await Effect.runPromise(
      makeEventTurnRunnerV2({ sessions: fake.v2Session, instanceStore: fake.instanceStore })(
        input({ directory: undefined, requiresWriteIsolation: true }),
      ),
    )
    expect(result).toMatchObject({ ok: false, reason: "isolation_unavailable" })
    expect(fake.prompts).toEqual([])
  })

  test("a new claim generation gets a new session and worktree rooted at the upstream ref", async () => {
    const fake = fakeServices()
    const created: { baseRef?: string; directory: string }[] = []
    const run = makeEventTurnRunnerV2({
      sessions: fake.v2Session,
      instanceStore: fake.instanceStore,
      createWorktree: async (request) => {
        created.push({ baseRef: request.baseRef, directory: request.eventDirectory })
        return {
          directory: path.join(request.eventDirectory, `isolated-${created.length}`),
          repoRoot: request.eventDirectory,
          baseSha: "abc",
          branch: `agent/isolated-${created.length}`,
        }
      },
      cleanupWorktree: async (worktree) => ({
        continuationRef: worktree.branch,
        artifacts: [`git-ref:${worktree.branch}`],
      }),
    })
    const first = await Effect.runPromise(run(input({ requiresWriteIsolation: true, baseRef: "refs/heads/fix" })))
    const second = await Effect.runPromise(
      run(input({ requiresWriteIsolation: true, baseRef: "refs/heads/rebased", generation: 2 })),
    )
    expect(first.ok && second.ok).toBe(true)
    expect(first.sessionID).not.toBe(second.sessionID)
    expect(fake.prompts[0].id).not.toBe(fake.prompts[1].id)
    expect(fake.sessions.get(first.sessionID ?? "")?.location.directory).toEndWith("isolated-1")
    expect(fake.sessions.get(second.sessionID ?? "")?.location.directory).toEndWith("isolated-2")
    expect(created).toEqual([
      { directory: path.resolve("event-workspace"), baseRef: "refs/heads/fix" },
      { directory: path.resolve("event-workspace"), baseRef: "refs/heads/rebased" },
    ])
  })

  test("uncertain worktree cleanup refuses to return a continuation ref", async () => {
    const fake = fakeServices()
    const result = await Effect.runPromise(
      makeEventTurnRunnerV2({
        sessions: fake.v2Session,
        instanceStore: fake.instanceStore,
        createWorktree: async (request) => ({
          directory: path.join(request.eventDirectory, "isolated"),
          repoRoot: request.eventDirectory,
          baseSha: "abc",
          branch: "agent/isolated",
        }),
        cleanupWorktree: async () => null,
      })(input({ requiresWriteIsolation: true })),
    )
    expect(result).toMatchObject({ ok: false, reason: "isolation_preservation_failed" })
  })

  test("turn timeout interrupts only its admitted child session", async () => {
    const fake = fakeServices({ stall: true })
    const result = await Effect.runPromise(
      makeEventTurnRunnerV2({ sessions: fake.v2Session, instanceStore: fake.instanceStore })(
        input({ maxTurnDurationMs: 10 }),
      ),
    )
    expect(result).toMatchObject({ ok: false, reason: "turn_timeout" })
    expect(fake.prompts).toHaveLength(1)
    expect(fake.interrupts).toEqual([fake.prompts[0].sessionID])
  })
})
