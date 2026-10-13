import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { LocalOperatorPolicy } from "@/im/local-operator-policy"

const target = {
  id: "review", directory: "/private/project", agentID: "auto", providerID: "deepseek", modelID: "deepseek-flash",
  profile: "project_deepseek_context_bound_v1",
  budget: { maxInputTokens: 1_048_576, maxCompletionTokens: 4_096, maxTotalTokens: 2_105_344,
    maxProviderDispatches: 2, maxToolCalls: 1, maxChildren: 0, maxDurationMs: 120_000,
    hourTokensMax: 2_105_344, hourWindowMinutes: 60 },
  project: { tools: ["read"], fileScope: {
    read: [{ kind: "file", path: "guard.test.ts" }], write: [], deny: [], maxReadBytes: 65_536,
    maxPageBytes: 51_200, maxHashBytes: 16_777_216, maxWriteBytes: 0, symlinks: "deny",
  } },
}
const parse = (input: unknown) => Effect.runPromise(LocalOperatorPolicy.parse(input).pipe(Effect.exit))

test("explicit policy v7 accepts the bounded formal DeepSeek read target without starting Native or a provider", async () => {
  const result = await parse({ version: 7, targets: [target] })
  expect(Exit.isSuccess(result)).toBe(true)
  if (Exit.isFailure(result)) throw result.cause
  expect(result.value.targets[0]).toEqual(target)
  expect(WorkAuthorityPolicy.checkContextBoundBudget(target.budget).ok).toBe(true)
})

test("new local bound policy cannot upgrade old files, accept another alias, guess authority, or enlarge a small budget", async () => {
  for (const input of [
    { version: 6, targets: [target] },
    { version: 7, targets: [{ ...target, providerID: "openai" }] },
    { version: 7, targets: [{ ...target, modelID: "deepseek-v4-pro" }] },
    { version: 7, targets: [{ ...target, profileHash: "a".repeat(64) }] },
    { version: 7, targets: [{ ...target, budget: { ...target.budget, maxInputTokens: 65_536 } }] },
    { version: 7, targets: [{ ...target, budget: { ...target.budget, maxTotalTokens: 131_072 } }] },
    { version: 7, targets: [{ ...target, budget: { ...target.budget, maxChildren: 1 } }] },
  ]) expect(Exit.isFailure(await parse(input))).toBe(true)
})

test("legacy v2 OpenAI project policy remains an explicit small original profile", async () => {
  const legacy = { ...target, providerID: "openai", modelID: "gpt-4.1-2025-04-14",
    budget: { ...WorkAuthorityPolicy.PROJECT_PROFILE.budget, maxProviderDispatches: 2, maxChildren: 0 } }
  Reflect.deleteProperty(legacy, "profile")
  const result = await parse({ version: 2, targets: [legacy] })
  expect(Exit.isSuccess(result)).toBe(true)
  if (Exit.isFailure(result)) throw result.cause
  expect(result.value.targets[0]).toEqual(legacy)
  expect(WorkAuthorityPolicy.PROJECT_PROFILE.budget.maxInputTokens).toBe(65_536)
})
