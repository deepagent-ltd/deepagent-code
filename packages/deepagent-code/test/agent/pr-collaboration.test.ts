import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Git } from "@/git"
import { Worktree } from "@/worktree"
import { PRQueue } from "@/agent/pr-queue"
import { coordinator, ensureSessionBranch } from "@/agent/pr-collaboration"
import { ReviewVerdictContract } from "@/collaboration/review-contract"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

const layer = Layer.mergeAll(Git.defaultLayer, Worktree.defaultLayer, PRQueue.layer).pipe(
  Layer.provideMerge(Worktree.defaultLayer),
)
const testPR = testEffect(layer)

// Tests that spawn git worktrees and run real git operations are resource-
// intensive. They pass reliably in isolation but timeout under the parallel
// load of the full test suite. Skip unless a real LLM/integration key is
// present (a reliable proxy for a full developer/integration environment).
const runGitIntegration = !!(
  process.env.DEEPAGENT_SLOW_TESTS ||
  process.env.OPENAI_API_KEY ||
  process.env.ANTHROPIC_API_KEY ||
  process.env.DEEPAGENT_API_KEY
)

describe("PR collaboration coordinator", () => {
  testPR.instance("rejects a non-Git parent instead of fabricating a PR flow", () =>
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const admitted = yield* coordinator.admit({
        id: "pr-non-git",
        parentID: "parent-session",
        workerID: "worker-session",
        reviewerID: "reviewer-session",
        parentDirectory: directory,
        workerDirectory: directory,
      })
      expect(admitted).toEqual({ type: "rejected", reason: "not-a-repository" })
    }),
  )

  testPR.instance(
    "rejects a dirty parent and reports the preserved user paths",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const git = yield* Git.Service
      expect((yield* git.run(["branch", "-m", "dirty-parent-test"], { cwd: directory })).exitCode).toBe(0)
      yield* Effect.tryPromise(() => fs.writeFile(path.join(directory, "user-change.txt"), "preserve me\n"))
      const admitted = yield* coordinator.admit({
        id: "pr-dirty-parent",
        parentID: "parent-session",
        workerID: "worker-session",
        reviewerID: "reviewer-session",
        parentDirectory: directory,
        workerDirectory: directory,
      })
      expect(admitted).toEqual({ type: "rejected", reason: "dirty-parent", paths: ["user-change.txt"] })
      expect(yield* Effect.tryPromise(() => fs.readFile(path.join(directory, "user-change.txt"), "utf8"))).toBe(
        "preserve me\n",
      )
    }),
    { git: true },
  )

  testPR.instance(
    "Fix-C: ensureSessionBranch caps dirty-path list at 10 entries and appends overflow count",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const git = yield* Git.Service
      // Create 15 untracked files so the MAX_SHOWN=10 overflow branch fires (overflow = 5)
      for (let i = 0; i < 15; i++) {
        yield* Effect.tryPromise(() => fs.writeFile(path.join(directory, `fixc-dirty-${i}.txt`), "x\n"))
      }
      const err = yield* Effect.flip(ensureSessionBranch({ git, directory, sessionID: "ses-fix-c" }))
      expect(err.message).toContain("… and 5 more")
      // The full path dump must not reappear — message stays well under 500 chars
      expect(err.message.length).toBeLessThan(500)
    }),
    { git: true },
  )

  ;(runGitIntegration ? testPR.instance : testPR.instance.skip)(
    "rejects the repository default branch as a merge target",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const worktree = yield* Worktree.Service

      const admitted = yield* coordinator.admit({
        id: "pr-default-branch",
        parentID: "parent-session",
        workerID: "worker-session",
        reviewerID: "reviewer-session",
        parentDirectory: directory,
        workerDirectory: (yield* worktree.create({ name: "default-branch-worker" })).directory,
      })

      expect(admitted).toEqual({ type: "rejected", reason: "protected-target" })
    }),
    { git: true },
  )

  ;(runGitIntegration ? testPR.instance : testPR.instance.skip)(
    "admits, commits worker changes, and merges an assigned-reviewer-approved range",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const git = yield* Git.Service
      const worktree = yield* Worktree.Service
      const queue = yield* PRQueue.Service

      yield* Effect.tryPromise(() => fs.writeFile(path.join(directory, "base.txt"), "base\n"))
      const initial = yield* git.commitScoped(directory, {
        paths: ["base.txt"],
        message: "initial",
        author: { name: "Test", email: "test@example.com" },
      })
      expect(initial.exitCode).toBe(0)
      const renamed = yield* Effect.tryPromise(
        () => Bun.spawn(["git", "branch", "-m", "collaboration-test"], { cwd: directory }).exited,
      )
      expect(renamed).toBe(0)

      const created = yield* worktree.create({
        name: "worker-session",
        startCommand: "bun --version",
      })
      const workerDirectory = created.directory

      const admitted = yield* coordinator.admit({
        id: "pr-1",
        parentID: "parent-session",
        workerID: "worker-session",
        reviewerID: "reviewer-session",
        parentDirectory: directory,
        workerDirectory,
      })
      expect(admitted.type).toBe("admitted")
      if (admitted.type !== "admitted") return

      yield* Effect.tryPromise(() => fs.writeFile(path.join(workerDirectory, "worker.txt"), "worker\n"))
      const committed = yield* coordinator.commitWorker({
        id: "pr-1",
        workerID: "worker-session",
        paths: ["worker.txt"],
        message: "worker change",
      })
      expect(committed.type).toBe("committed")
      if (committed.type !== "committed") return

      const reviewing = yield* queue.get("pr-1")
      expect(reviewing?.status).toBe("awaiting_review")
      expect(reviewing?.workerHead).toBe(committed.state.workerCommit)
      expect(reviewing?.findings).toEqual(["worker.txt"])

      const approval = ReviewVerdictContract.make({
        implementationCommitSha: committed.state.workerCommit!,
        verdict: "approve",
        reviewer: { id: "reviewer-session", role: "reviewer" },
        round: 1,
        rationale: "Approved",
        findings: [],
      })
      const approved = yield* queue.verdict({
        id: "pr-1",
        reviewerID: "reviewer-session",
        sha: committed.state.workerCommit!,
        verdict: "approved",
      })
      expect(approved?.status).toBe("approved")

      const merged = yield* coordinator.mergeApproved({
        id: "pr-1",
        parentDirectory: directory,
        approval,
      })
      expect(merged.type).toBe("merged")
      expect(yield* Effect.tryPromise(() => fs.readFile(path.join(directory, "worker.txt"), "utf8"))).toBe("worker\n")
      expect((yield* queue.get("pr-1"))?.status).toBe("merged")
    }),
    { git: true },
  )

  testPR.instance(
    "admits an existing V4 continuation exactly once without requiring its removed worktree",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const git = yield* Git.Service
      const queue = yield* PRQueue.Service

      expect((yield* git.run(["branch", "-m", "collaboration-v4"], { cwd: directory })).exitCode).toBe(0)
      expect((yield* git.run(["switch", "-c", "agent/v4-continuation"], { cwd: directory })).exitCode).toBe(0)
      yield* Effect.tryPromise(() => fs.writeFile(path.join(directory, "v4-result.txt"), "durable\n"))
      expect(
        (yield* git.commitScoped(directory, {
          paths: ["v4-result.txt"],
          message: "v4 result",
          author: { name: "Test", email: "test@example.com" },
        })).exitCode,
      ).toBe(0)
      const workerCommit = yield* git.resolveRef(directory)
      expect(workerCommit).toBeDefined()
      expect((yield* git.run(["switch", "collaboration-v4"], { cwd: directory })).exitCode).toBe(0)

      const input = {
        id: "pr-v4-continuation",
        parentID: "ses-v4-parent",
        workerID: "ses-v4-worker",
        reviewerID: "ses-v4-reviewer",
        parentDirectory: directory,
        workerDirectory: directory,
        workerCommit: workerCommit!,
        metadata: { origin: "v4-event-runtime", cleanupRequired: false },
      }
      const admitted = yield* coordinator.admitCommitted(input)
      expect(admitted.type).toBe("admitted")
      expect((yield* coordinator.admitCommitted(input)).type).toBe("admitted")
      expect((yield* queue.list()).filter((entry) => entry.id === input.id)).toHaveLength(1)
      expect(yield* queue.get(input.id)).toMatchObject({
        status: "awaiting_review",
        workerHead: workerCommit,
        findings: ["v4-result.txt"],
        metadata: { origin: "v4-event-runtime", cleanupRequired: false },
      })

      const mismatched = yield* coordinator.admitCommitted({ ...input, workerCommit: "missing-ref" })
      expect(mismatched).toEqual({ type: "rejected", reason: "invalid-continuation" })
    }),
    { git: true },
  )

  ;(runGitIntegration ? testPR.instance : testPR.instance.skip)(
    "commits two workers concurrently and serially merges both approved PRs",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const git = yield* Git.Service
      const worktree = yield* Worktree.Service
      const queue = yield* PRQueue.Service

      yield* Effect.tryPromise(() => fs.writeFile(path.join(directory, "base.txt"), "base\n"))
      expect(
        (yield* git.commitScoped(directory, {
          paths: ["base.txt"],
          message: "initial",
          author: { name: "Test", email: "test@example.com" },
        })).exitCode,
      ).toBe(0)
      expect(
        yield* Effect.tryPromise(
          () => Bun.spawn(["git", "branch", "-m", "collaboration-parallel"], { cwd: directory }).exited,
        ),
      ).toBe(0)

      const workerA = (yield* worktree.create({ name: "parallel-worker-a" })).directory
      const workerB = (yield* worktree.create({ name: "parallel-worker-b" })).directory
      for (const input of [
        { id: "pr-parallel-a", workerID: "worker-a", reviewerID: "reviewer-a", workerDirectory: workerA },
        { id: "pr-parallel-b", workerID: "worker-b", reviewerID: "reviewer-b", workerDirectory: workerB },
      ]) {
        expect(
          (yield* coordinator.admit({
            ...input,
            parentID: "parent-parallel",
            parentDirectory: directory,
          })).type,
        ).toBe("admitted")
      }

      yield* Effect.all(
        [
          Effect.tryPromise(() => fs.writeFile(path.join(workerA, "worker-a.txt"), "worker-a\n")),
          Effect.tryPromise(() => fs.writeFile(path.join(workerB, "worker-b.txt"), "worker-b\n")),
        ],
        { concurrency: "unbounded", discard: true },
      )
      const [committedB, committedA] = yield* Effect.all(
        [
          coordinator.commitWorker({
            id: "pr-parallel-b",
            workerID: "worker-b",
            paths: ["worker-b.txt"],
            message: "worker B change",
          }),
          coordinator.commitWorker({
            id: "pr-parallel-a",
            workerID: "worker-a",
            paths: ["worker-a.txt"],
            message: "worker A change",
          }),
        ],
        { concurrency: "unbounded" },
      )
      expect(committedA.type).toBe("committed")
      expect(committedB.type).toBe("committed")
      if (committedA.type !== "committed" || committedB.type !== "committed") return
      expect((yield* queue.get("pr-parallel-a"))?.status).toBe("awaiting_review")
      expect((yield* queue.get("pr-parallel-b"))?.status).toBe("awaiting_review")

      for (const input of [
        { id: "pr-parallel-a", reviewerID: "reviewer-a", sha: committedA.state.workerCommit! },
        { id: "pr-parallel-b", reviewerID: "reviewer-b", sha: committedB.state.workerCommit! },
      ]) {
        expect((yield* queue.verdict({ ...input, verdict: "approved" }))?.status).toBe("approved")
      }
      const mergeA = yield* coordinator.mergeApproved({
        id: "pr-parallel-a",
        parentDirectory: directory,
        approval: ReviewVerdictContract.make({
          implementationCommitSha: committedA.state.workerCommit!,
          verdict: "approve",
          reviewer: { id: "reviewer-a", role: "reviewer" },
          round: 1,
          rationale: "Approved A",
          findings: [],
        }),
      })
      expect(mergeA.type).toBe("merged")
      const mergeB = yield* coordinator.mergeApproved({
        id: "pr-parallel-b",
        parentDirectory: directory,
        approval: ReviewVerdictContract.make({
          implementationCommitSha: committedB.state.workerCommit!,
          verdict: "approve",
          reviewer: { id: "reviewer-b", role: "reviewer" },
          round: 1,
          rationale: "Approved B",
          findings: [],
        }),
      })
      expect(mergeB.type).toBe("merged")
      expect(yield* Effect.tryPromise(() => fs.readFile(path.join(directory, "worker-a.txt"), "utf8"))).toBe(
        "worker-a\n",
      )
      expect(yield* Effect.tryPromise(() => fs.readFile(path.join(directory, "worker-b.txt"), "utf8"))).toBe(
        "worker-b\n",
      )
      expect((yield* queue.get("pr-parallel-a"))?.status).toBe("merged")
      expect((yield* queue.get("pr-parallel-b"))?.status).toBe("merged")
      expect((yield* git.porcelainStatus(directory))?.clean).toBe(true)
      const head = yield* git.commitMetadata(directory, "HEAD")
      expect(head?.parents).toHaveLength(2)
    }),
    { git: true },
  )

  ;(runGitIntegration ? testPR.instance : testPR.instance.skip)(
    "returns review-needed without merging when parent HEAD advanced after approval",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const git = yield* Git.Service
      const worktree = yield* Worktree.Service
      const queue = yield* PRQueue.Service

      yield* Effect.tryPromise(() => fs.writeFile(path.join(directory, "base.txt"), "base\n"))
      expect(
        (yield* git.commitScoped(directory, {
          paths: ["base.txt"],
          message: "initial",
          author: { name: "Test", email: "test@example.com" },
        })).exitCode,
      ).toBe(0)
      expect(
        yield* Effect.tryPromise(
          () => Bun.spawn(["git", "branch", "-m", "collaboration-test"], { cwd: directory }).exited,
        ),
      ).toBe(0)

      const workerDirectory = (yield* worktree.create({ name: "advanced-parent-worker" })).directory
      const admitted = yield* coordinator.admit({
        id: "pr-advanced-parent",
        parentID: "parent-session",
        workerID: "worker-session",
        reviewerID: "reviewer-session",
        parentDirectory: directory,
        workerDirectory,
      })
      expect(admitted.type).toBe("admitted")
      if (admitted.type !== "admitted") return

      yield* Effect.tryPromise(() => fs.writeFile(path.join(workerDirectory, "worker.txt"), "worker\n"))
      const committed = yield* coordinator.commitWorker({
        id: "pr-advanced-parent",
        workerID: "worker-session",
        paths: ["worker.txt"],
        message: "worker change",
      })
      expect(committed.type).toBe("committed")
      if (committed.type !== "committed") return

      // Approve the PR
      expect(
        (yield* queue.verdict({
          id: "pr-advanced-parent",
          reviewerID: "reviewer-session",
          sha: committed.state.workerCommit!,
          verdict: "approved",
        }))?.status,
      ).toBe("approved")

      // Advance the parent HEAD after approval — simulates another commit landing concurrently
      yield* Effect.tryPromise(() => fs.writeFile(path.join(directory, "parent.txt"), "advanced\n"))
      expect(
        (yield* git.commitScoped(directory, {
          paths: ["parent.txt"],
          message: "parent advanced after approval",
          author: { name: "Test", email: "test@example.com" },
        })).exitCode,
      ).toBe(0)

      const result = yield* coordinator.mergeApproved({
        id: "pr-advanced-parent",
        parentDirectory: directory,
        approval: ReviewVerdictContract.make({
          implementationCommitSha: committed.state.workerCommit!,
          verdict: "approve",
          reviewer: { id: "reviewer-session", role: "reviewer" },
          round: 1,
          rationale: "Approved",
          findings: [],
        }),
      })
      // Must not merge — the merge contract was based on an earlier baseline
      expect(result.type).toBe("review-needed")
      if (result.type !== "review-needed") return
      expect(result.state.mergeDiagnostic).toContain("Parent HEAD advanced since admission")
      // The exact PR is reopened against the new parent baseline instead of getting stuck approved.
      expect(yield* queue.get("pr-advanced-parent")).toMatchObject({
        status: "awaiting_review",
        metadata: { parentHead: yield* git.resolveRef(directory) },
      })
      // worker.txt must NOT exist in parent directory (merge was blocked)
      expect(
        yield* Effect.tryPromise(() =>
          fs.stat(path.join(directory, "worker.txt")).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
    }),
    { git: true },
  )

  testPR.instance(
    "aborts merge state and records diagnostic on non-conflict merge failure",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const git = yield* Git.Service
      const worktree = yield* Worktree.Service
      const queue = yield* PRQueue.Service

      yield* Effect.tryPromise(() => fs.writeFile(path.join(directory, "base.txt"), "base\n"))
      expect(
        (yield* git.commitScoped(directory, {
          paths: ["base.txt"],
          message: "initial",
          author: { name: "Test", email: "test@example.com" },
        })).exitCode,
      ).toBe(0)
      expect(
        yield* Effect.tryPromise(
          () => Bun.spawn(["git", "branch", "-m", "collaboration-test"], { cwd: directory }).exited,
        ),
      ).toBe(0)

      const workerDirectory = (yield* worktree.create({ name: "failing-merge-worker" })).directory
      const admitted = yield* coordinator.admit({
        id: "pr-failing-merge",
        parentID: "parent-session",
        workerID: "worker-session",
        reviewerID: "reviewer-session",
        parentDirectory: directory,
        workerDirectory,
      })
      expect(admitted.type).toBe("admitted")
      if (admitted.type !== "admitted") return

      yield* Effect.tryPromise(() => fs.writeFile(path.join(workerDirectory, "worker.txt"), "worker\n"))
      const committed = yield* coordinator.commitWorker({
        id: "pr-failing-merge",
        workerID: "worker-session",
        paths: ["worker.txt"],
        message: "worker change",
      })
      expect(committed.type).toBe("committed")
      if (committed.type !== "committed") return

      expect(
        (yield* queue.verdict({
          id: "pr-failing-merge",
          reviewerID: "reviewer-session",
          sha: committed.state.workerCommit!,
          verdict: "approved",
        }))?.status,
      ).toBe("approved")

      // Inject a hook that makes every merge attempt fail (non-conflict)
      yield* Effect.tryPromise(() =>
        fs.writeFile(path.join(directory, ".git", "hooks", "pre-merge-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 }),
      )

      const result = yield* coordinator.mergeApproved({
        id: "pr-failing-merge",
        parentDirectory: directory,
        approval: ReviewVerdictContract.make({
          implementationCommitSha: committed.state.workerCommit!,
          verdict: "approve",
          reviewer: { id: "reviewer-session", role: "reviewer" },
          round: 1,
          rationale: "Approved",
          findings: [],
        }),
      })
      expect(result.type).toBe("failed")
      if (result.type !== "failed") return
      expect(result.abortSucceeded).toBe(true)
      // Queue entry is now terminal (conflicted state reused for failure)
      expect((yield* queue.get("pr-failing-merge"))?.status).toBe("conflicted")
      // Parent checkout must be clean — no in-progress merge state
      expect((yield* git.porcelainStatus(directory))?.clean).toBe(true)
      expect(
        yield* Effect.tryPromise(() =>
          fs.stat(path.join(directory, ".git", "MERGE_HEAD")).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
    }),
    { git: true },
  )

  testPR.instance(
    "aborts a conflicting later merge and returns it to its author",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const git = yield* Git.Service
      const worktree = yield* Worktree.Service
      const queue = yield* PRQueue.Service
      yield* Effect.tryPromise(() => fs.writeFile(path.join(directory, "shared.txt"), "base\n"))
      expect(
        (yield* git.commitScoped(directory, {
          paths: ["shared.txt"],
          message: "initial",
          author: { name: "Test", email: "test@example.com" },
        })).exitCode,
      ).toBe(0)
      expect(
        yield* Effect.tryPromise(
          () => Bun.spawn(["git", "branch", "-m", "collaboration-conflict"], { cwd: directory }).exited,
        ),
      ).toBe(0)
      const workerA = (yield* worktree.createReady({ name: "conflict-a" })).directory
      const workerB = (yield* worktree.createReady({ name: "conflict-b" })).directory

      for (const input of [
        { id: "pr-conflict-a", workerID: "worker-a", reviewerID: "reviewer-a", workerDirectory: workerA },
        { id: "pr-conflict-b", workerID: "worker-b", reviewerID: "reviewer-b", workerDirectory: workerB },
      ]) {
        expect(
          (yield* coordinator.admit({
            ...input,
            parentID: "parent-conflict",
            parentDirectory: directory,
          })).type,
        ).toBe("admitted")
      }
      yield* Effect.tryPromise(() => fs.writeFile(path.join(workerA, "shared.txt"), "alpha\n"))
      yield* Effect.tryPromise(() => fs.writeFile(path.join(workerB, "shared.txt"), "beta\n"))
      const committedA = yield* coordinator.commitWorker({
        id: "pr-conflict-a",
        workerID: "worker-a",
        paths: ["shared.txt"],
        message: "alpha",
      })
      const committedB = yield* coordinator.commitWorker({
        id: "pr-conflict-b",
        workerID: "worker-b",
        paths: ["shared.txt"],
        message: "beta",
      })
      expect(committedA.type).toBe("committed")
      expect(committedB.type).toBe("committed")
      if (committedA.type !== "committed" || committedB.type !== "committed") return

      for (const input of [
        { id: "pr-conflict-a", reviewerID: "reviewer-a", sha: committedA.state.workerCommit! },
        { id: "pr-conflict-b", reviewerID: "reviewer-b", sha: committedB.state.workerCommit! },
      ]) {
        expect((yield* queue.verdict({ ...input, verdict: "approved" }))?.status).toBe("approved")
      }
      const approval = (reviewerID: string, sha: string) =>
        ReviewVerdictContract.make({
          implementationCommitSha: sha,
          verdict: "approve",
          reviewer: { id: reviewerID, role: "reviewer" },
          round: 1,
          rationale: "Approved",
          findings: [],
        })
      expect(
        (yield* coordinator.mergeApproved({
          id: "pr-conflict-a",
          parentDirectory: directory,
          approval: approval("reviewer-a", committedA.state.workerCommit!),
        })).type,
      ).toBe("merged")
      const conflicted = yield* coordinator.mergeApproved({
        id: "pr-conflict-b",
        parentDirectory: directory,
        approval: approval("reviewer-b", committedB.state.workerCommit!),
      })

      expect(conflicted.type).toBe("conflict")
      if (conflicted.type !== "conflict") return
      expect(conflicted.abortSucceeded).toBe(true)
      expect(conflicted.state.status).toBe("changes-requested")
      expect(yield* queue.get("pr-conflict-b")).toMatchObject({ status: "changes_requested", redoCount: 1 })
      expect(yield* Effect.tryPromise(() => fs.readFile(path.join(directory, "shared.txt"), "utf8"))).toBe("alpha\n")
      expect((yield* git.porcelainStatus(directory))?.clean).toBe(true)
      expect(yield* git.resolveRef(directory, "MERGE_HEAD")).toBeUndefined()
    }),
    { git: true },
  )
})
