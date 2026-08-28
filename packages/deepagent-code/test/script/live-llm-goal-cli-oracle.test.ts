import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  assertGoalCliLifecycleOrder,
  assertGoalCliVerifierEvidence,
  requirePostFeedbackMutations,
} from "../../script/live-llm/goal-cli-oracle"

const order = {
  goalStartIndex: 0,
  runningIndex: 1,
  feedbackIndex: 2,
  doneIndex: 3,
  terminalIndex: 4,
}

describe("D2/E1 Goal CLI hard Oracle", () => {
  test("rejects lifecycle ordering mutations", () => {
    expect(() => assertGoalCliLifecycleOrder(order)).not.toThrow()
    for (const mutation of [
      { ...order, goalStartIndex: -1 },
      { ...order, runningIndex: 0 },
      { ...order, feedbackIndex: 1 },
      { ...order, doneIndex: 2 },
      { ...order, terminalIndex: 3 },
    ]) {
      expect(() => assertGoalCliLifecycleOrder(mutation)).toThrow("lifecycle ordering")
    }
  })

  test("requires both target mutations after the exact gap and later plan persistence", () => {
    const tools = [
      { index: 3, name: "edit", input: { filePath: "feedback.txt" } },
      { index: 4, name: "write", input: { filePath: "result.txt" } },
      { index: 5, name: "plan", input: {} },
    ]
    expect(
      requirePostFeedbackMutations({
        tools,
        feedbackIndex: 2,
        workspace: "/workspace",
        files: ["feedback.txt", "result.txt"],
      }).map((tool) => tool.index),
    ).toEqual([3, 4])
    expect(() =>
      requirePostFeedbackMutations({
        tools: [{ index: 1, name: "edit", input: { filePath: "result.txt" } }, ...tools],
        feedbackIndex: 2,
        workspace: "/workspace",
        files: ["feedback.txt", "result.txt"],
      }),
    ).toThrow("before the grader gap")
    expect(() =>
      requirePostFeedbackMutations({
        tools: tools.filter((tool) => tool.input.filePath !== "result.txt"),
        feedbackIndex: 2,
        workspace: "/workspace",
        files: ["feedback.txt", "result.txt"],
      }),
    ).toThrow("never mutated result.txt")
    expect(() =>
      requirePostFeedbackMutations({
        tools: [
          { index: 3, name: "edit", input: { filePath: "feedback.txt" } },
          { index: 4, name: "plan", input: {} },
          { index: 5, name: "edit", input: { filePath: "result.txt" } },
        ],
        feedbackIndex: 2,
        workspace: "/workspace",
        files: ["feedback.txt", "result.txt"],
      }),
    ).toThrow("after all grader-driven file mutations")
  })

  test("canonicalizes workspace aliases before matching absolute tool paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "goal-cli-oracle-"))
    const workspace = path.join(root, "workspace")
    try {
      await mkdir(workspace)
      await Promise.all([
        Bun.write(path.join(workspace, "feedback.txt"), "PENDING\n"),
        Bun.write(path.join(workspace, "result.txt"), "BROKEN\n"),
      ])
      const canonicalWorkspace = await realpath(workspace)
      expect(
        requirePostFeedbackMutations({
          tools: [
            { index: 3, name: "edit", input: { filePath: path.join(canonicalWorkspace, "feedback.txt") } },
            { index: 4, name: "edit", input: { filePath: path.join(canonicalWorkspace, "result.txt") } },
            { index: 5, name: "plan", input: {} },
          ],
          feedbackIndex: 2,
          workspace,
          files: ["feedback.txt", "result.txt"],
        }).map((tool) => tool.index),
      ).toEqual([3, 4])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects verifier bypass and unexpected workspace mutations", () => {
    const evidence = {
      initialExitCode: 1,
      finalExitCode: 0,
      freshCopyExitCode: 0,
      changedPaths: ["feedback.txt", "result.txt"],
      expectedPaths: ["feedback.txt", "result.txt"],
    }
    expect(() => assertGoalCliVerifierEvidence(evidence)).not.toThrow()
    expect(() => assertGoalCliVerifierEvidence({ ...evidence, initialExitCode: 0 })).toThrow("passed before")
    expect(() => assertGoalCliVerifierEvidence({ ...evidence, finalExitCode: 1 })).toThrow("failed after")
    expect(() => assertGoalCliVerifierEvidence({ ...evidence, freshCopyExitCode: 1 })).toThrow("fresh-copy")
    expect(() => assertGoalCliVerifierEvidence({ ...evidence, changedPaths: [...evidence.changedPaths, "extra.txt"] })).toThrow(
      "unexpected paths",
    )
  })
})
