import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { ApprovalQueue } from "@deepagent-code/core/deepagent/approval-queue"
import { Database } from "@deepagent-code/core/database/database"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { TaskPartitioner } from "@deepagent-code/core/deepagent/task-partitioner"
import { PRQueue } from "@/agent/pr-queue"
import { Git } from "@/git"
import type { InstanceStore } from "@/project/instance-store"
import type { Session } from "@/session/session"
import { parentSessionIDFor } from "@/session/multi-agent-runtime"
import { V4PRCollaboration } from "@/session/v4-pr-collaboration"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const database = Database.layerFromPath(":memory:")
const durable = Layer.mergeAll(DeepAgentEventBus.layer, ApprovalQueue.layer).pipe(Layer.provideMerge(database))
const it = testEffect(Layer.mergeAll(Git.defaultLayer, PRQueue.layer, durable))

describe("V4 PR collaboration bridge", () => {
  it.instance(
    "queues the terminal continuation once and escalates it through the Approval Queue",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const git = yield* Git.Service
      const queue = yield* PRQueue.Service
      const bus = yield* DeepAgentEventBus.Service
      const approvalQueue = yield* ApprovalQueue.Service

      expect((yield* git.run(["branch", "-m", "dev"], { cwd: directory })).exitCode).toBe(0)
      expect((yield* git.run(["switch", "-c", "agent/v4-bridge"], { cwd: directory })).exitCode).toBe(0)
      yield* Effect.tryPromise(() => fs.writeFile(path.join(directory, "bridge.txt"), "bridged\n"))
      expect(
        (yield* git.commitScoped(directory, {
          paths: ["bridge.txt"],
          message: "v4 bridge result",
          author: { name: "Test", email: "test@example.com" },
        })).exitCode,
      ).toBe(0)
      const continuationRef = yield* git.resolveRef(directory)
      expect(continuationRef).toBeDefined()
      expect((yield* git.run(["switch", "dev"], { cwd: directory })).exitCode).toBe(0)

      const event: DeepAgentEvent.Event = {
        id: DeepAgentEvent.ID.create(10_000),
        type: "ci.failure",
        source: "ci",
        workspaceID: directory,
        idempotencyKey: "v4-pr-bridge",
        priority: "normal",
        createdAt: 10_000,
        payload: { directory, files: ["bridge.txt"] },
      }
      const task = TaskPartitioner.partition(event, { stableIDPrefix: event.id }).subtasks.at(-1)!
      const records = new Map<string, { readonly id: string; directory?: string }>([
        ["ses_v4_bridge_worker", { id: "ses_v4_bridge_worker", directory }],
      ])
      const sessions = {
        get: (id: string) => {
          const record = records.get(id)
          return record ? Effect.succeed(record) : Effect.fail(new Error("missing session"))
        },
        create: (input: { id?: string }) =>
          Effect.sync(() => {
            const record = { id: input.id! }
            records.set(record.id, record)
            return record
          }),
        setDirectory: (input: { sessionID: string; directory: string }) =>
          Effect.sync(() => {
            const record = records.get(input.sessionID)
            if (!record) throw new Error("missing session")
            record.directory = input.directory
          }),
      } as unknown as Session.Interface
      const instanceStore = {
        load: () =>
          Effect.succeed({
            directory,
            worktree: directory,
            project: { id: "project-v4-bridge", worktree: directory, vcs: "git" },
          }),
      } as unknown as InstanceStore.Interface
      const bridge = V4PRCollaboration.make({ sessions, instanceStore, git, queue, bus, approvalQueue })
      const input = {
        event,
        parentSessionID: parentSessionIDFor(event.id),
        turns: [
          {
            task,
            agentID: "builtin:codefix",
            sessionID: "ses_v4_bridge_worker",
            continuationRef,
            artifacts: ["session:ses_v4_bridge_worker", `git-ref:${continuationRef}`],
          },
        ],
      }
      yield* bridge(input)
      yield* bridge(input)

      const entries = (yield* queue.list()).filter((entry) => entry.metadata?.eventID === event.id)
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        parentID: input.parentSessionID,
        workerID: "ses_v4_bridge_worker",
        workerHead: continuationRef,
        status: "awaiting_review",
        metadata: { origin: "v4-event-runtime", cleanupRequired: true },
      })
      expect(yield* approvalQueue.listPending(directory)).toHaveLength(1)
      expect(yield* git.branch(directory)).toBe(`deepagent-code/session-${input.parentSessionID}`)
      const workerDirectory = records.get("ses_v4_bridge_worker")?.directory
      expect(workerDirectory).toBeString()
      expect(workerDirectory).not.toBe(directory)
      expect(entries[0]?.metadata?.workerDirectory).toBe(workerDirectory)
      expect(yield* git.resolveRef(workerDirectory!)).toBe(continuationRef)
      const workerBranch = yield* git.branch(workerDirectory!)
      expect((yield* git.run(["worktree", "remove", "--force", workerDirectory!], { cwd: directory })).exitCode).toBe(0)
      expect((yield* git.run(["branch", "-D", workerBranch!], { cwd: directory })).exitCode).toBe(0)
    }),
    { git: true },
  )

  it.instance(
    "does not switch the parent branch or escalate when a terminal turn made no changes",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const git = yield* Git.Service
      const queue = yield* PRQueue.Service
      const bus = yield* DeepAgentEventBus.Service
      const approvalQueue = yield* ApprovalQueue.Service

      expect((yield* git.run(["branch", "-m", "dev"], { cwd: directory })).exitCode).toBe(0)
      const continuationRef = yield* git.resolveRef(directory)
      expect(continuationRef).toBeDefined()
      const event: DeepAgentEvent.Event = {
        id: DeepAgentEvent.ID.create(20_000),
        type: "ci.failure",
        source: "ci",
        workspaceID: directory,
        idempotencyKey: "v4-pr-read-only",
        priority: "normal",
        createdAt: 20_000,
        payload: { directory, files: ["README.md"] },
      }
      const task = TaskPartitioner.partition(event, { stableIDPrefix: event.id }).subtasks.at(-1)!
      const records = new Map<string, { readonly id: string }>([
        ["ses_v4_read_only_worker", { id: "ses_v4_read_only_worker" }],
      ])
      const sessions = {
        get: (id: string) => {
          const record = records.get(id)
          return record ? Effect.succeed(record) : Effect.fail(new Error("missing session"))
        },
        create: (input: { id?: string }) =>
          Effect.sync(() => {
            const record = { id: input.id! }
            records.set(record.id, record)
            return record
          }),
        setDirectory: () => Effect.die("read-only turn must not relocate its Session"),
      } as unknown as Session.Interface
      const instanceStore = {
        load: () =>
          Effect.succeed({
            directory,
            worktree: directory,
            project: { id: "project-v4-read-only", worktree: directory, vcs: "git" },
          }),
      } as unknown as InstanceStore.Interface

      yield* V4PRCollaboration.make({ sessions, instanceStore, git, queue, bus, approvalQueue })({
        event,
        parentSessionID: parentSessionIDFor(event.id),
        turns: [
          {
            task,
            agentID: "builtin:codefix",
            sessionID: "ses_v4_read_only_worker",
            continuationRef,
            artifacts: ["session:ses_v4_read_only_worker", `git-ref:${continuationRef}`],
          },
        ],
      })

      expect((yield* queue.list()).filter((entry) => entry.metadata?.eventID === event.id)).toHaveLength(0)
      expect(yield* approvalQueue.listPending(directory)).toHaveLength(0)
      expect(yield* git.branch(directory)).toBe("dev")
    }),
    { git: true },
  )
})
