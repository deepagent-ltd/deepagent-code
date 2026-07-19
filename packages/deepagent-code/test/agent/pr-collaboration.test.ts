import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Git } from "@/git"
import { Worktree } from "@/worktree"
import { PRQueue } from "@/agent/pr-queue"
import { coordinator } from "@/agent/pr-collaboration"
import { ReviewVerdictContract } from "@/collaboration/review-contract"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

const layer = Layer.mergeAll(Git.defaultLayer, Worktree.defaultLayer, PRQueue.layer).pipe(Layer.provideMerge(Worktree.defaultLayer))
const testPR = testEffect(layer)

describe("PR collaboration coordinator", () => {
  testPR.instance(
    "admits, commits worker changes, and merges a senior-approved range",
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
        const renamed = yield* Effect.tryPromise(() =>
          Bun.spawn(["git", "branch", "-m", "collaboration-test"], { cwd: directory }).exited,
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
          reviewerID: "senior-session",
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
          reviewer: { id: "senior-session", role: "senior-reviewer" },
          round: 1,
          rationale: "Approved",
          findings: [],
        })
        const approved = yield* queue.verdict({
          id: "pr-1",
          reviewerID: "senior-session",
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
        yield* Effect.tryPromise(() => Bun.spawn(["git", "branch", "-m", "collaboration-test"], { cwd: directory }).exited),
      ).toBe(0)

      const workerDirectory = (yield* worktree.create({ name: "advanced-parent-worker" })).directory
      const admitted = yield* coordinator.admit({
        id: "pr-advanced-parent",
        parentID: "parent-session",
        workerID: "worker-session",
        reviewerID: "senior-session",
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
          reviewerID: "senior-session",
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
          reviewer: { id: "senior-session", role: "senior-reviewer" },
          round: 1,
          rationale: "Approved",
          findings: [],
        }),
      })
      // Must not merge — the merge contract was based on an earlier baseline
      expect(result.type).toBe("review-needed")
      if (result.type !== "review-needed") return
      expect(result.state.mergeDiagnostic).toContain("Parent HEAD advanced since admission")
      // Queue entry remains approved — not consumed by a failed merge attempt
      expect((yield* queue.get("pr-advanced-parent"))?.status).toBe("approved")
      // worker.txt must NOT exist in parent directory (merge was blocked)
      expect(
        yield* Effect.tryPromise(() =>
          fs.stat(path.join(directory, "worker.txt")).then(() => true, () => false),
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
        yield* Effect.tryPromise(() => Bun.spawn(["git", "branch", "-m", "collaboration-test"], { cwd: directory }).exited),
      ).toBe(0)

      const workerDirectory = (yield* worktree.create({ name: "failing-merge-worker" })).directory
      const admitted = yield* coordinator.admit({
        id: "pr-failing-merge",
        parentID: "parent-session",
        workerID: "worker-session",
        reviewerID: "senior-session",
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
          reviewerID: "senior-session",
          sha: committed.state.workerCommit!,
          verdict: "approved",
        }))?.status,
      ).toBe("approved")

      // Inject a hook that makes every merge attempt fail (non-conflict)
      yield* Effect.tryPromise(() =>
        fs.writeFile(
          path.join(directory, ".git", "hooks", "pre-merge-commit"),
          "#!/bin/sh\nexit 1\n",
          { mode: 0o755 },
        ),
      )

      const result = yield* coordinator.mergeApproved({
        id: "pr-failing-merge",
        parentDirectory: directory,
        approval: ReviewVerdictContract.make({
          implementationCommitSha: committed.state.workerCommit!,
          verdict: "approve",
          reviewer: { id: "senior-session", role: "senior-reviewer" },
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
          fs.stat(path.join(directory, ".git", "MERGE_HEAD")).then(() => true, () => false),
        ),
      ).toBe(false)
    }),
    { git: true },
  )
})
