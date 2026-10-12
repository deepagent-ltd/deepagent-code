import { expect, test } from "bun:test"
import { runtimeStateCandidates } from "../script/runtime-state-inventory"

test("runtime state inventory excludes declarations and dependency implementations", () => {
  expect(
    runtimeStateCandidates(
      "packages/im-kernel-sdk/upstream/src/index.d.ts",
      "declare class Client { pending: Map<string, Promise<void>> }",
    ),
  ).toEqual([])
  expect(
    runtimeStateCandidates(
      "packages/im-kernel-sdk/upstream/node_modules/sdk/src/client.ts",
      "const pending = new Map<string, object>(); pending.set('task', {})",
    ),
  ).toEqual([])
  const current = runtimeStateCandidates(
    "packages/core/src/new-runtime.ts",
    "const pending = new Map<string, object>(); pending.set('task', {})",
  )
  expect(current).toHaveLength(1)
  expect(current[0]?.verdict).toBe("review_required")
})

test("reviewed runtime owners survive inserted lines and reject ambiguous owner reuse", () => {
  const file = "packages/core/src/session/run-coordinator.ts"
  const source = "Effect.gen(function* () { const active = new Map(); return { run: () => active.set('one', 1) } })"
  const original = runtimeStateCandidates(file, source)
  const moved = runtimeStateCandidates(file, "\n\n// inserted context\n" + source)
  expect(original).toHaveLength(1)
  expect(moved[0]?.key).not.toBe(original[0]?.key)
  expect(moved[0]?.verdict).toBe("safe_scoped")
  expect(moved[0]?.owner).toBe("SessionRunCoordinator-instance")
  const ambiguous = runtimeStateCandidates(file, source + ";\n" + source)
  expect(ambiguous).toHaveLength(2)
  expect(ambiguous.every((candidate) => candidate.verdict === "review_required")).toBe(true)
  expect(runtimeStateCandidates("packages/core/src/new-coordinator.ts", source)[0]?.verdict).toBe("review_required")
})
