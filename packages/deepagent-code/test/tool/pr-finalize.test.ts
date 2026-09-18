import { afterEach, describe, expect } from "bun:test"
import path from "node:path"
import { Effect, Exit, Layer } from "effect"
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
import { submitAutomaticWorktree } from "@/session/task-pr-submission"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import type { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { PRFinalizeTool } from "@/tool/pr_finalize"
import type { TaskPromptOps } from "@/tool/task"
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
        const reviewAssignments = new Map<
          string,
          { readonly sha: string; readonly reviewerID: string; readonly round: number; readonly role: string }
        >()
        const reviewerSessions = new Set<string>()
        const seniorSessions = new Set<string>()
        let failFirstSeniorTurn = true

        // The task tool's automatic-worktree submission path is gone with the V2 authority
        // cutover; PRs are seeded directly through the durable submission helper (#29 owns the
        // PR-tooling migration onto the authority). The finalize choreography is unchanged.
        const seedPR = (file: string, prID: string) =>
          Effect.gen(function* () {
            yield* ensureSessionBranch({ git, directory, sessionID: chat.id })
            const worker = yield* sessions.create({
              title: `implement ${file}`,
              parentID: chat.id,
              agent: "general",
            })
            const info = yield* worktree.createReady({ name: `agent-general-${worker.id}` })
            yield* Effect.promise(() => Bun.write(path.join(info.directory, file), `${file}\n`))
            const submitted = yield* submitAutomaticWorktree({
              git,
              queue,
              info,
              parentDirectory: directory,
              parentSessionID: chat.id,
              workerSessionID: worker.id,
              reviewerSessionID: SessionID.make(`ses_pr_reviewer_${assistant.id}`),
              batchID: assistant.id,
              prID,
              description: `implement ${file}`,
              prompt: `write ${file}`,
            })
            if (!submitted) return yield* Effect.die("worker submission produced no PR")
            return { workerID: worker.id, directory: info.directory, ...submitted }
          })
        const taskResults = yield* Effect.all(
          [
            seedPR("worker-a.txt", `pr:${chat.id}:tool_worker_a`),
            seedPR("worker-b.txt", `pr:${chat.id}:tool_worker_b`),
          ],
          { concurrency: "unbounded" },
        )

        const promptOps: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.gen(function* () {
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

        expect(taskResults.map((result) => result.id)).toEqual([
          `pr:${chat.id}:tool_worker_a`,
          `pr:${chat.id}:tool_worker_b`,
        ])
        expect((yield* queue.list()).filter((entry) => entry.status === "awaiting_review")).toHaveLength(2)
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
        const git = yield* Git.Service
        const queue = yield* PRQueue.Service
        const worktree = yield* Worktree.Service
        const { chat, assistant } = yield* seed()
        const assignments = new Map<
          string,
          { readonly sha: string; readonly reviewerID: string; readonly round: number; readonly role: string }
        >()
        const reviewerSessions = new Set<string>()
        const seniorSessions = new Set<string>()

        const promptOps: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.gen(function* () {
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
        // Direct PR seeding (see the two-worker test): the initial worker submission.
        const initialInfo = { name: "agent-general-revision", directory: "" }
        const prID = `pr:${chat.id}:tool_revision_initial`
        const initial = yield* Effect.gen(function* () {
          yield* ensureSessionBranch({ git, directory, sessionID: chat.id })
          const worker = yield* sessions.create({
            title: "implement revision",
            parentID: chat.id,
            agent: "general",
          })
          const info = yield* worktree.createReady({ name: `agent-general-${worker.id}` })
          initialInfo.directory = info.directory
          yield* Effect.promise(() => Bun.write(path.join(info.directory, "revision.txt"), "buggy\n"))
          const submitted = yield* submitAutomaticWorktree({
            git,
            queue,
            info,
            parentDirectory: directory,
            parentSessionID: chat.id,
            workerSessionID: worker.id,
            reviewerSessionID: SessionID.make(`ses_pr_reviewer_${assistant.id}`),
            batchID: assistant.id,
            prID,
            description: "implement revision",
            prompt: "write initial revision",
          })
          if (!submitted) return yield* Effect.die("worker submission produced no PR")
          return { workerID: worker.id, id: submitted.id }
        })
        const finalize = yield* PRFinalizeTool
        const finalizeDef = yield* finalize.init()
        const firstReview = yield* finalizeDef.execute({}, context("tool_review_initial"))

        expect(firstReview.output).toContain('"status":"changes_requested"')
        expect(firstReview.output).toContain('"summary":"Known bad value"')
        expect(firstReview.output).toContain(String(initial.workerID))
        expect(yield* queue.get(prID)).toMatchObject({ status: "changes_requested", redoCount: 1 })
        expect(seniorSessions.size).toBe(0)
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "revision.txt")).exists())).toBe(false)

        // The worker revises in its preserved worktree and resubmits the SAME PR.
        const revised = yield* Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(path.join(initialInfo.directory, "revision.txt"), "fixed\n"))
          const submitted = yield* submitAutomaticWorktree({
            git,
            queue,
            info: { name: "agent-general-revision", directory: initialInfo.directory },
            parentDirectory: directory,
            parentSessionID: chat.id,
            workerSessionID: initial.workerID,
            reviewerSessionID: SessionID.make(`ses_pr_reviewer_${assistant.id}`),
            batchID: assistant.id,
            prID,
            description: "revise implementation",
            prompt: "revise revision.txt",
          })
          if (!submitted) return yield* Effect.die("worker revision produced no PR")
          return submitted
        })
        expect(revised.id).toBe(prID)
        expect((yield* queue.get(prID))?.workerHead).toBe(revised.workerCommit)
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
              batchID: MessageID.ascending(),
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

        // The V4 author revises in its managed worktree and resubmits the SAME PR.
        const revision = yield* Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(path.join(authorWorktree.directory, "v4-revision.txt"), "fixed\n"))
          const submitted = yield* submitAutomaticWorktree({
            git,
            queue,
            info: { name: "v4-review-revision", directory: authorWorktree.directory },
            parentDirectory: directory,
            parentSessionID: chat.id,
            workerSessionID: worker.id,
            reviewerSessionID: reviewerID,
            batchID: MessageID.ascending(),
            prID,
            description: "revise V4 implementation",
            prompt: "replace the buggy value in v4-revision.txt with fixed",
          })
          if (!submitted) return yield* Effect.die("V4 revision produced no PR")
          return submitted
        })
        expect(revision.id).toBe(prID)
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
        const git = yield* Git.Service
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
        const prID = `pr:${chat.id}:tool_rejected_worker`
        const submitted = yield* Effect.gen(function* () {
          yield* ensureSessionBranch({ git, directory, sessionID: chat.id })
          const worker = yield* sessions.create({
            title: "implement rejected change",
            parentID: chat.id,
            agent: "general",
          })
          const info = yield* worktree.createReady({ name: `agent-general-${worker.id}` })
          yield* Effect.promise(() => Bun.write(path.join(info.directory, "rejected.txt"), "unsafe\n"))
          const pr = yield* submitAutomaticWorktree({
            git,
            queue,
            info,
            parentDirectory: directory,
            parentSessionID: chat.id,
            workerSessionID: worker.id,
            reviewerSessionID: SessionID.make(`ses_pr_reviewer_${assistant.id}`),
            batchID: assistant.id,
            prID,
            description: "implement rejected change",
            prompt: "write rejected.txt",
          })
          if (!pr) return yield* Effect.die("worker submission produced no PR")
          return pr
        })
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
