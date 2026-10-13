import { expect, test } from "bun:test"
import { Effect } from "effect"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { LocalOperatorPolicy } from "../../src/im/local-operator-policy"

const target = {
  id: "shared", directory: "/private/absent-shared-policy", agentID: "auto", providerID: "fixture", modelID: "model",
  profile: "project_shared_root_v1", budget: WorkAuthorityPolicy.SHARED_ROOT_PROFILE.budget,
  children: { kind: "shared_root_v1", maxConcurrent: 2, agents: ["explore"], toolIDs: ["read"],
    budget: { ...WorkAuthorityPolicy.PROJECT_PROFILE.budget, maxChildren: 0 } },
  project: { tools: ["read", "task"], fileScope: { read: [{ kind: "tree", path: "src" }], write: [], deny: [],
    maxReadBytes: 67_108_864, maxPageBytes: 51_200, maxHashBytes: 16_777_216, maxWriteBytes: 0, symlinks: "deny" } },
} as const
const parse = (value: unknown) => Effect.runPromise(LocalOperatorPolicy.parse(value))

test("shared root requires explicit version six and preserves exact parent and child budget data", async () => {
  const policy = { version: 6 as const, targets: [target] }
  expect(await parse(policy)).toEqual(policy)
  for (const version of [1, 2, 3, 4, 5])
    await expect(parse({ ...policy, version })).rejects.toMatchObject({ code: "LOCAL_OPERATOR_INVALID" })
})

test("shared root pure parser refuses expanded or implicit delegation without touching resolver services", async () => {
  for (const children of [
    { ...target.children, agents: ["explore", "explore"] },
    { ...target.children, maxConcurrent: 3 },
    { ...target.children, toolIDs: ["task"] },
    { ...target.children, toolIDs: ["read", "read"] },
    { ...target.children, toolIDs: ["write"] },
    { ...target.children, budget: { ...target.children.budget, maxChildren: 1 } },
    { ...target.children, budget: { ...target.children.budget, maxTotalTokens: target.budget.maxTotalTokens + 1 } },
  ]) await expect(parse({ version: 6, targets: [{ ...target, children }] })).rejects.toMatchObject({ code: "LOCAL_OPERATOR_INVALID" })
  await expect(parse({ version: 6, targets: [{ ...target, project: { ...target.project, tools: ["read"] } }] })).rejects.toMatchObject({ code: "LOCAL_OPERATOR_INVALID" })
})
