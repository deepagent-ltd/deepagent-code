import path from "node:path"
import { existsSync, realpathSync } from "node:fs"

export type GoalCliEventOrder = {
  goalStartIndex: number
  runningIndex: number
  feedbackIndex: number
  doneIndex: number
  terminalIndex: number
}

export type GoalCliToolEvidence = {
  index: number
  name: string
  input: Readonly<Record<string, unknown>>
}

export function assertGoalCliLifecycleOrder(order: GoalCliEventOrder) {
  if (
    order.goalStartIndex < 0 ||
    order.runningIndex <= order.goalStartIndex ||
    order.feedbackIndex <= order.runningIndex ||
    order.doneIndex <= order.feedbackIndex ||
    order.terminalIndex <= order.doneIndex
  ) {
    throw new Error(`D2/E1 lifecycle ordering was invalid: ${JSON.stringify(order)}`)
  }
}

export function requirePostFeedbackMutations(input: {
  tools: ReadonlyArray<GoalCliToolEvidence>
  feedbackIndex: number
  workspace: string
  files: readonly string[]
}) {
  const targets = new Map(input.files.map((file) => [canonicalPath(input.workspace, file), file] as const))
  const mutations = input.tools.filter((tool) => {
    if (!["write", "edit"].includes(tool.name) || typeof tool.input.filePath !== "string") return false
    return targets.has(canonicalPath(input.workspace, tool.input.filePath))
  })
  const premature = mutations.find((tool) => tool.index < input.feedbackIndex)
  if (premature) {
    throw new Error(`D2 Goal worker mutated a target file before the grader gap: ${String(premature.input.filePath)}`)
  }

  const missing = [...targets].flatMap(([target, file]) =>
    mutations.some(
      (tool) =>
        tool.index > input.feedbackIndex &&
        typeof tool.input.filePath === "string" &&
        canonicalPath(input.workspace, tool.input.filePath) === target,
    )
      ? []
      : [file],
  )
  if (missing.length > 0) {
    throw new Error(
      `D2 Goal worker never mutated ${missing.join(", ")} after the grader gap: ${input.tools.map((tool) => tool.name).join(" -> ")}`,
    )
  }

  const lastMutationIndex = Math.max(...mutations.map((tool) => tool.index))
  if (!input.tools.some((tool) => tool.index > lastMutationIndex && tool.name === "plan")) {
    throw new Error("D2 Goal worker did not persist plan completion after all grader-driven file mutations")
  }
  return mutations.filter((tool) => tool.index > input.feedbackIndex)
}

function canonicalPath(workspace: string, file: string) {
  const resolved = path.resolve(workspace, file)
  return existsSync(resolved) ? realpathSync.native(resolved) : resolved
}

export function assertGoalCliVerifierEvidence(input: {
  initialExitCode: number
  finalExitCode: number
  freshCopyExitCode: number
  changedPaths: readonly string[]
  expectedPaths: readonly string[]
}) {
  if (input.initialExitCode === 0) throw new Error("D2/E1 hidden verifier passed before the Goal Loop ran")
  if (input.finalExitCode !== 0) {
    throw new Error(`D2/E1 hidden verifier failed after the Goal Loop: ${input.finalExitCode}`)
  }
  if (input.freshCopyExitCode !== 0) {
    throw new Error(`D2/E1 fresh-copy verifier failed: ${input.freshCopyExitCode}`)
  }
  if (input.changedPaths.toSorted().join("\0") !== input.expectedPaths.toSorted().join("\0")) {
    throw new Error(`D2/E1 changed unexpected paths: ${input.changedPaths.join(", ")}`)
  }
}
