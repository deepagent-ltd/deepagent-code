import { afterEach, describe, expect } from "bun:test"
import path from "node:path"
import { Deferred, Effect, Exit, Layer } from "effect"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Database } from "@deepagent-code/core/database/database"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Agent } from "@/agent/agent"
import { coordinator, ensureSessionBranch } from "@/agent/pr-collaboration"
import { PRQueue } from "@/agent/pr-queue"
import { SUBAGENT_DEPTH_META_KEY } from "@/agent/subagent-permissions"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Git } from "@/git"
import { Session } from "@/session/session"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { createAgentWorktree } from "@/session/agent-worktree"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import type { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { PRFinalizeTool } from "@/tool/pr_finalize"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Worktree } from "@/worktree"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"

afterEach(async () => {
  await disposeAllInstances()
})

const model = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = Layer.mergeAll(
  Agent.defaultLayer,
  BackgroundJob.defaultLayer,
  EventV2Bridge.defaultLayer,
  Config.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Session.defaultLayer,
  // QUAL-007: the core SessionProjector materializes event-created sessions; without it message
  // writes hit the session FK.
  SessionProjector.defaultLayer,
  SessionRunState.defaultLayer,
  SessionStatus.defaultLayer,
  Truncate.defaultLayer,
  ToolRegistry.defaultLayer,
  Database.defaultLayer,
  RuntimeFlags.defaultLayer,
  Worktree.defaultLayer,
  Git.defaultLayer,
  PRQueue.layer,
)

const it = testEffect(layer)

const seed = Effect.fn("PRFinalizeTest.seed")(function* () {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "PR collaboration" })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: chat.directory, root: chat.directory },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: model.modelID,
    providerID: model.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* sessions.updateMessage(assistant)
  return { chat, assistant }
})

function reply(input: SessionPrompt.PromptInput, text: string, structured?: unknown): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? model.modelID,
      providerID: input.model?.providerID ?? model.providerID,
      time: { created: Date.now() },
      finish: "stop",
      ...(structured === undefined ? {} : { structured }),
    },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text }],
  }
}

function promptText(input: SessionPrompt.PromptInput) {
  return input.parts
    .filter((part): part is Extract<(typeof input.parts)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

function reviewAssignment(input: SessionPrompt.PromptInput) {
  const text = promptText(input)
  const sha = text.match(/implementation commit ([0-9a-f]{40})/i)?.[1]
  const reviewerID = text.match(/reviewer id is ([^;\s]+)/i)?.[1]
  const round = Number(text.match(/round is (\d+)/i)?.[1])
  if (!sha || !reviewerID || !round) return
  return { sha, reviewerID, round, role: input.agent ?? "reviewer" }
}

describe("tool.pr_finalize", () => {
  it.instance(
    "runs two workers, one batch reviewer, serial merges, and one senior review",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const sessions = yield* Session.Service
        const git = yield* Git.Service
        const queue = yield* PRQueue.Service
        const worktree = yield* Worktree.Service
        const { chat, assistant } = yield* seed()
        const bothStarted = yield* Deferred.make<void>()
        const reviewAssignments = new Map<
          string,
          { readonly sha: string; readonly reviewerID: string; readonly round: number; readonly role: string }
        >()
        const reviewerSessions = new Set<string>()
        const seniorSessions = new Set<string>()
        let workersStarted = 0
        let failFirstSeniorTurn = true

        const promptOps: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.gen(function* () {
              if (input.agent === "general") {
                const file = promptText(input).includes("worker-a.txt") ? "worker-a.txt" : "worker-b.txt"
                const child = yield* sessions.get(input.sessionID)
                yield* Effect.promise(() => Bun.write(path.join(child.directory, file), `${file}\n`))
                workersStarted += 1
                if (workersStarted === 2) yield* Deferred.succeed(bothStarted, undefined)
                yield* Deferred.await(bothStarted)
                return reply(input, `implemented ${file}`)
              }

              const incoming = reviewAssignment(input)
              if (incoming) {
                if (incoming.role === "reviewer") {
                  expect(promptText(input)).toContain("<task_contract>")
                  expect(promptText(input)).toContain("<worker_execution_evidence>")
                  expect(promptText(input)).toMatch(/write worker-[ab]\.txt|write revision\.txt|write rejected\.txt/)
                }
                reviewAssignments.set(input.sessionID, incoming)
                if (incoming.role === "reviewer") reviewerSessions.add(input.sessionID)
                if (incoming.role === "senior-reviewer") {
                  seniorSessions.add(input.sessionID)
                  if (!input.format && failFirstSeniorTurn) {
                    failFirstSeniorTurn = false
                    return yield* Effect.fail(new Error("injected senior reviewer failure"))
                  }
                  if (!input.format && incoming.round === 1) {
                    yield* Effect.promise(() => Bun.write(path.join(directory, "senior-fix.txt"), "senior fixed\n"))
                  }
                }
                if (!input.format && input.metadata?.deepagent?.structured_direct === undefined)
                  return reply(input, `Reviewed ${incoming.sha}; no findings.`)
              }

              const assignment = reviewAssignments.get(input.sessionID)
              if (!assignment) return yield* Effect.die("structured review lacks prior assignment")
              const finalizer = promptText(input)
              expect(finalizer).toContain(`Set reviewer.id to exactly ${assignment.reviewerID}.`)
              expect(finalizer).toContain(`Set reviewer.role to exactly ${assignment.role}.`)
              expect(finalizer).toContain(`Set round to exactly ${assignment.round}.`)
              expect(finalizer).toContain(`Set implementationCommitSha to exactly ${assignment.sha}.`)
              const verdict = {
                reviewer: { id: assignment.reviewerID, role: assignment.role },
                round: assignment.round,
                implementationCommitSha: assignment.sha,
                verdict: "approve",
                rationale: "No findings after exact-SHA review.",
                findings: [],
              }
              const directAttempt = input.metadata?.deepagent?.structured_direct?.attempt
              if (directAttempt === 1) return reply(input, "not json")
              if (directAttempt === 2) return reply(input, JSON.stringify(verdict))
              return reply(input, "approved", verdict)
            }),
        }

        const task = yield* TaskTool
        const taskDef = yield* task.init()
        const execute = (file: string, callID: string) =>
          taskDef.execute(
            { description: `implement ${file}`, prompt: `write ${file}`, subagent_type: "general" },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              callID,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
        const taskResults = yield* Effect.all(
          [execute("worker-a.txt", "tool_worker_a"), execute("worker-b.txt", "tool_worker_b")],
          { concurrency: "unbounded" },
        )

        expect(taskResults.every((result) => result.output.includes('state="awaiting_review"'))).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "worker-a.txt")).exists())).toBe(false)
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "worker-b.txt")).exists())).toBe(false)
        expect((yield* queue.list()).filter((entry) => entry.parentID === chat.id)).toHaveLength(2)
        expect(yield* worktree.list()).toHaveLength(2)

        const finalize = yield* PRFinalizeTool
        const finalizeDef = yield* finalize.init()
        const finalizeContext = (callID: string) => ({
          sessionID: chat.id,
          messageID: assistant.id,
          callID,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        })
        const interruptedStageReview = yield* Effect.exit(
          finalizeDef.execute({}, finalizeContext("tool_pr_finalize_first")),
        )
        expect(Exit.isFailure(interruptedStageReview)).toBe(true)
        const pendingStageEntries = (yield* queue.list()).filter((entry) => entry.parentID === chat.id)
        expect(pendingStageEntries.map((entry) => entry.status)).toEqual(["merged", "merged"])
        expect(pendingStageEntries.map((entry) => entry.metadata?.stageReview)).toEqual([
          expect.objectContaining({ status: "pending", reviewerID: [...seniorSessions][0] }),
          expect.objectContaining({ status: "pending", reviewerID: [...seniorSessions][0] }),
        ])

        const finalized = yield* finalizeDef.execute({}, finalizeContext("tool_pr_finalize_retry"))

        expect(finalized.output).toContain('"status":"approved"')
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "worker-a.txt")).text())).toBe(
          "worker-a.txt\n",
        )
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "worker-b.txt")).text())).toBe(
          "worker-b.txt\n",
        )
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "senior-fix.txt")).text())).toBe(
          "senior fixed\n",
        )
        expect(
          (yield* queue.list()).filter((entry) => entry.parentID === chat.id).map((entry) => entry.status),
        ).toEqual(["merged", "merged"])
        expect(
          (yield* queue.list())
            .filter((entry) => entry.parentID === chat.id)
            .map((entry) => entry.metadata?.stageReview),
        ).toEqual([
          expect.objectContaining({ status: "approved", reviewerID: [...seniorSessions][0] }),
          expect.objectContaining({ status: "approved", reviewerID: [...seniorSessions][0] }),
        ])
        expect(reviewerSessions.size).toBe(1)
        expect(seniorSessions.size).toBe(1)
        expect([...reviewAssignments.values()].find((assignment) => assignment.role === "senior-reviewer")?.round).toBe(
          2,
        )
        expect((yield* sessions.children(chat.id)).filter((child) => child.agent === "reviewer")).toHaveLength(1)
        expect((yield* sessions.children(chat.id)).filter((child) => child.agent === "senior-reviewer")).toHaveLength(1)
        expect(
          (yield* sessions.children(chat.id)).find((child) => child.agent === "reviewer")?.metadata?.deepagent
            ?.subagent,
        ).toMatchObject({
          state: "completed",
          reason: "structured_output_text_fallback",
          attempts: 2,
          structured_output: { attempt: 2, transport: "text_fallback" },
        })
        expect(yield* worktree.list()).toEqual([])
        expect((yield* git.porcelainStatus(directory))?.clean).toBe(true)
        expect(
          (yield* git.run(["log", "--format=%H", "--merges", "HEAD"], { cwd: directory }))
            .text()
            .split("\n")
            .filter(Boolean),
        ).toHaveLength(2)
      }),
    { git: true },
    20_000,
  )

  it.instance(
    "returns findings to the original author and defers senior review until the revised SHA merges",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const sessions = yield* Session.Service
        const queue = yield* PRQueue.Service
        const worktree = yield* Worktree.Service
        const { chat, assistant } = yield* seed()
        const assignments = new Map<
          string,
          { readonly sha: string; readonly reviewerID: string; readonly round: number; readonly role: string }
        >()
        const reviewerSessions = new Set<string>()
        const seniorSessions = new Set<string>()
        const workerDirectories = new Set<string>()

        const promptOps: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.gen(function* () {
              if (input.agent === "general") {
                const child = yield* sessions.get(input.sessionID)
                workerDirectories.add(child.directory)
                const revised = promptText(input).includes("revise")
                yield* Effect.promise(() =>
                  Bun.write(path.join(child.directory, "revision.txt"), revised ? "fixed\n" : "buggy\n"),
                )
                return reply(input, revised ? "fixed revision" : "initial revision")
              }
              const incoming = reviewAssignment(input)
              if (incoming) {
                if (incoming.role === "reviewer") {
                  expect(promptText(input)).toContain("<task_contract>")
                  expect(promptText(input)).toMatch(/write (?:initial|revised) revision/)
                }
                assignments.set(input.sessionID, incoming)
                if (incoming.role === "reviewer") reviewerSessions.add(input.sessionID)
                if (incoming.role === "senior-reviewer") seniorSessions.add(input.sessionID)
                if (!input.format) {
                  return reply(
                    input,
                    incoming.role === "reviewer" && incoming.round === 1 ? "revision.txt is buggy" : "no findings",
                  )
                }
              }
              const assignment = assignments.get(input.sessionID)
              if (!assignment) return yield* Effect.die("structured review lacks prior assignment")
              const changes = assignment.role === "reviewer" && assignment.round === 1
              return reply(input, changes ? "changes requested" : "approved", {
                reviewer: { id: assignment.reviewerID, role: assignment.role },
                round: assignment.round,
                implementationCommitSha: assignment.sha,
                verdict: changes ? "request_changes" : "approve",
                rationale: changes ? "revision.txt contains the known bad value" : "No findings remain.",
                findings: changes
                  ? [
                      {
                        severity: "high",
                        summary: "Known bad value",
                        rationale: "revision.txt still contains buggy",
                        file: "revision.txt",
                      },
                    ]
                  : [],
              })
            }),
        }
        const context = (callID: string) => ({
          sessionID: chat.id,
          messageID: assistant.id,
          callID,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        })
        const task = yield* TaskTool
        const taskDef = yield* task.init()
        const initial = yield* taskDef.execute(
          { description: "implement revision", prompt: "write initial revision", subagent_type: "general" },
          context("tool_revision_initial"),
        )
        const prID = String(initial.metadata.prId)
        const finalize = yield* PRFinalizeTool
        const finalizeDef = yield* finalize.init()
        const firstReview = yield* finalizeDef.execute({}, context("tool_review_initial"))

        expect(firstReview.output).toContain('"status":"changes_requested"')
        expect(firstReview.output).toContain('"summary":"Known bad value"')
        expect(firstReview.output).toContain(String(initial.metadata.sessionId))
        expect(yield* queue.get(prID)).toMatchObject({ status: "changes_requested", redoCount: 1 })
        expect(seniorSessions.size).toBe(0)
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "revision.txt")).exists())).toBe(false)

        const revised = yield* taskDef.execute(
          {
            description: "revise implementation",
            prompt: "revise revision.txt",
            subagent_type: "general",
            task_id: String(initial.metadata.sessionId),
          },
          context("tool_revision_fix"),
        )
        expect(revised.metadata.prId).toBe(prID)
        expect(workerDirectories.size).toBe(1)
        expect(yield* queue.get(prID)).toMatchObject({ status: "awaiting_review", redoCount: 1 })

        const secondReview = yield* finalizeDef.execute({}, context("tool_review_revised"))
        expect(secondReview.output).toContain('"status":"approved"')
        expect((yield* queue.get(prID))?.status).toBe("merged")
        expect(reviewerSessions.size).toBe(1)
        expect(seniorSessions.size).toBe(1)
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "revision.txt")).text())).toBe("fixed\n")
        expect(yield* worktree.list()).toEqual([])
      }),
    { git: true },
    20_000,
  )

  it.instance(
    "revises and merges a V4 PR through the original child Session and managed worktree",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const sessions = yield* Session.Service
        const git = yield* Git.Service
        const queue = yield* PRQueue.Service
        const worktree = yield* Worktree.Service
        const { chat, assistant } = yield* seed()
        yield* ensureSessionBranch({ git, directory, sessionID: chat.id })
        const authorWorktree = yield* Effect.promise(() =>
          createAgentWorktree({ eventDirectory: directory, label: "v4-review-revision" }),
        )
        if (!authorWorktree) return yield* Effect.die("unable to create V4 author worktree")
        yield* Effect.addFinalizer(() => worktree.remove({ directory: authorWorktree.directory }).pipe(Effect.ignore))
        yield* Effect.promise(() => Bun.write(path.join(authorWorktree.directory, "v4-revision.txt"), "buggy\n"))
        expect(
          (yield* git.commitScoped(authorWorktree.directory, {
            paths: ["v4-revision.txt"],
            message: "initial V4 implementation",
            author: { name: "Test", email: "test@example.com" },
          })).exitCode,
        ).toBe(0)
        const workerHead = yield* git.resolveRef(authorWorktree.directory)
        if (!workerHead) return yield* Effect.die("missing V4 worker HEAD")
        const worker = yield* sessions.create({
          parentID: chat.id,
          title: "V4 revision author",
          agent: "general",
          directory: authorWorktree.directory,
          metadata: { deepagent: { [SUBAGENT_DEPTH_META_KEY]: 1 } },
        })
        const reviewerID = SessionID.create()
        const prID = `pr:v4:test:${worker.id}`
        const admitted = yield* coordinator
          .admitCommitted({
            id: prID,
            parentID: chat.id,
            workerID: worker.id,
            reviewerID,
            parentDirectory: directory,
            workerDirectory: authorWorktree.directory,
            workerCommit: workerHead,
            cleanupRequired: true,
            metadata: {
              origin: "v4-event-runtime",
              batchID: "v4-revision-batch",
              eventID: "dae_v4_revision",
              taskID: "v4-revision-task",
              prompt: "replace the buggy value in v4-revision.txt with fixed",
            },
          })
          .pipe(Effect.provideService(Git.Service, git), Effect.provideService(PRQueue.Service, queue))
        expect(admitted.type).toBe("admitted")

        const assignments = new Map<
          string,
          { readonly sha: string; readonly reviewerID: string; readonly round: number; readonly role: string }
        >()
        const promptOps: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.gen(function* () {
              if (input.agent === "general") {
                const child = yield* sessions.get(input.sessionID)
                expect(child.id).toBe(worker.id)
                expect(child.directory).toBe(authorWorktree.directory)
                yield* Effect.promise(() => Bun.write(path.join(child.directory, "v4-revision.txt"), "fixed\n"))
                return reply(input, "fixed V4 revision")
              }
              const incoming = reviewAssignment(input)
              if (incoming) {
                assignments.set(input.sessionID, incoming)
                if (!input.format) return reply(input, incoming.round === 1 ? "known bug remains" : "no findings")
              }
              const assignment = assignments.get(input.sessionID)
              if (!assignment) return yield* Effect.die("structured review lacks assignment")
              const changes = assignment.role === "reviewer" && assignment.round === 1
              return reply(input, changes ? "changes requested" : "approved", {
                reviewer: { id: assignment.reviewerID, role: assignment.role },
                round: assignment.round,
                implementationCommitSha: assignment.sha,
                verdict: changes ? "request_changes" : "approve",
                rationale: changes ? "v4-revision.txt still contains buggy" : "No findings remain.",
                findings: changes
                  ? [
                      {
                        severity: "high",
                        summary: "Known V4 bug",
                        rationale: "The submitted value is still buggy.",
                        file: "v4-revision.txt",
                      },
                    ]
                  : [],
              })
            }),
        }
        const context = (callID: string) => ({
          sessionID: chat.id,
          messageID: assistant.id,
          callID,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        })
        const finalize = yield* PRFinalizeTool
        const finalizeDef = yield* finalize.init()
        const first = yield* finalizeDef.execute({ pr_ids: [prID] }, context("tool_v4_review_initial"))
        expect(first.output).toContain('"status":"changes_requested"')
        expect(yield* queue.get(prID)).toMatchObject({ status: "changes_requested", redoCount: 1 })

        const task = yield* TaskTool
        const taskDef = yield* task.init()
        const revision = yield* taskDef.execute(
          {
            description: "revise V4 implementation",
            prompt: "replace the buggy value in v4-revision.txt with fixed",
            subagent_type: "general",
            task_id: worker.id,
          },
          context("tool_v4_revision"),
        )
        expect(revision.metadata.prId).toBe(prID)
        expect(yield* queue.get(prID)).toMatchObject({ status: "awaiting_review", redoCount: 1 })

        const second = yield* finalizeDef.execute({ pr_ids: [prID] }, context("tool_v4_review_revised"))
        expect(second.output).toContain('"status":"approved"')
        expect(yield* queue.get(prID)).toMatchObject({ status: "merged", redoCount: 1 })
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "v4-revision.txt")).text())).toBe("fixed\n")
        expect((yield* worktree.list()).some((entry) => entry.directory === authorWorktree.directory)).toBe(false)
      }),
    { git: true },
    20_000,
  )

  it.instance(
    "persists an explicit Reviewer rejection as terminal and preserves the author worktree",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const sessions = yield* Session.Service
        const queue = yield* PRQueue.Service
        const worktree = yield* Worktree.Service
        const { chat, assistant } = yield* seed()
        const assignments = new Map<
          string,
          { readonly sha: string; readonly reviewerID: string; readonly round: number; readonly role: string }
        >()
        const promptOps: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.gen(function* () {
              if (input.agent === "general") {
                const child = yield* sessions.get(input.sessionID)
                yield* Effect.promise(() => Bun.write(path.join(child.directory, "rejected.txt"), "unsafe\n"))
                return reply(input, "implemented unsafe change")
              }
              const incoming = reviewAssignment(input)
              if (incoming) {
                expect(promptText(input)).toContain("<task_contract>")
                expect(promptText(input)).toContain("write rejected.txt")
                assignments.set(input.sessionID, incoming)
              }
              if (!input.format) return reply(input, "unsafe change must be rejected")
              const assignment = assignments.get(input.sessionID)
              if (!assignment) return yield* Effect.die("structured review lacks prior assignment")
              return reply(input, "rejected", {
                reviewer: { id: assignment.reviewerID, role: assignment.role },
                round: assignment.round,
                implementationCommitSha: assignment.sha,
                verdict: "reject",
                rationale: "The change is not safe to revise in this batch.",
                findings: [
                  {
                    severity: "critical",
                    summary: "Unsafe change",
                    rationale: "The submitted file represents a terminal policy violation.",
                    file: "rejected.txt",
                  },
                ],
              })
            }),
        }
        const context = (callID: string) => ({
          sessionID: chat.id,
          messageID: assistant.id,
          callID,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        })
        const task = yield* TaskTool
        const taskDef = yield* task.init()
        const submitted = yield* taskDef.execute(
          { description: "implement rejected change", prompt: "write rejected.txt", subagent_type: "general" },
          context("tool_rejected_worker"),
        )
        const prID = String(submitted.metadata.prId)
        const finalize = yield* PRFinalizeTool
        const finalized = yield* (yield* finalize.init()).execute({}, context("tool_rejected_review"))

        expect(finalized.output).toContain('"status":"rejected"')
        expect(yield* queue.get(prID)).toMatchObject({ status: "rejected", redoCount: 0 })
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "rejected.txt")).exists())).toBe(false)
        expect(yield* worktree.list()).toHaveLength(1)
        expect((yield* sessions.children(chat.id)).filter((child) => child.agent === "reviewer")).toHaveLength(1)
        expect((yield* sessions.children(chat.id)).filter((child) => child.agent === "senior-reviewer")).toHaveLength(0)
      }),
    { git: true },
    15_000,
  )
})
