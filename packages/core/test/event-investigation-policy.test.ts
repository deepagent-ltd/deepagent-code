import { expect, test } from "bun:test"
import { WorkAuthorityPolicy } from "../src/session/work-authority-policy"
import { EventInvestigationFixture } from "./fixture/event-investigation"

test("existing signed project and text profiles retain their exact content hashes", () => {
  expect(WorkAuthorityPolicy.PROJECT_PROFILE_HASH).toBe("91f818914d67956676de5fafdf32f5bfdc35144bbfccfb2fc50f397fbf1b65ba")
  expect(WorkAuthorityPolicy.TEXT_ONLY_PROFILE_HASH).toBe("1c2a80b1572f6a2a9f7f89743c65b51e3896d6956431e8647b73eedfd25cc626")
  expect(WorkAuthorityPolicy.PROJECT_PROFILE.budget.maxProviderDispatches).toBe(32)
  expect(WorkAuthorityPolicy.profileFor({ id: "event_investigate_v1", version: 1, hash: WorkAuthorityPolicy.PROJECT_PROFILE_HASH })).toBeUndefined()
})

test("investigation is explicit bounded v2 data with no execution authorization", () => {
  const input = EventInvestigationFixture.binding()
  const result = WorkAuthorityPolicy.validateBinding(input)
  expect(result.ok).toBe(true)
  if (!result.ok) throw result.error
  expect(result.authorization).toBe("not_checked")
  expect(result.value.budget).toEqual({ maxTotalTokens: 32_768, maxInputTokens: 16_384,
    maxCompletionTokens: 4_096, maxProviderDispatches: 8, maxToolCalls: 32, maxChildren: 0,
    maxDurationMs: 600_000, hourTokensMax: 32_768, hourWindowMinutes: 60 })
  expect(WorkAuthorityPolicy.profileFor(result.value.profile)?.instructions).toBe(WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE.instructions)
  expect(WorkAuthorityPolicy.validateBinding({ ...input, schemaVersion: "work-execution.v1" }).ok).toBe(false)
  expect(WorkAuthorityPolicy.validateBinding({ ...input, source: { ...input.source, kind: "server_operator" } }).ok).toBe(false)
  expect(WorkAuthorityPolicy.checkInvestigationPolicy({ ...input,
    contextPolicy: { ...input.contextPolicy, instructionsRevision: 2 } }).ok).toBe(false)
})

test("investigation cannot borrow project mutation, command, integration or child capabilities", () => {
  const input = EventInvestigationFixture.binding()
  for (const toolPolicy of [
    { ...input.toolPolicy, capabilities: [{ ...input.toolPolicy.capabilities[0]!, toolID: "edit" }] },
    { ...input.toolPolicy, capabilities: [{ ...input.toolPolicy.capabilities[0]!, operations: ["read", "write"] }] },
    { ...input.toolPolicy, capabilities: [] },
    { ...input.toolPolicy, fileScope: { ...input.toolPolicy.fileScope, read: [{ kind: "tree", path: "src" }] } },
    { ...input.toolPolicy, fileScope: { ...input.toolPolicy.fileScope, write: [{ kind: "file", path: "input.ts" }] } },
    { ...input.toolPolicy, fileScope: { ...input.toolPolicy.fileScope, maxWriteBytes: 1 } },
    { ...input.toolPolicy, fileScope: { ...input.toolPolicy.fileScope, maxReadBytes: 67_108_865 } },
    { ...input.toolPolicy, integrations: [{ kind: "network", capability: { id: "net", revision: 1, hash: "a".repeat(64) }, resources: ["remote"] }] },
  ]) expect(WorkAuthorityPolicy.validateBinding({ ...input, toolPolicy }).ok).toBe(false)
  expect(WorkAuthorityPolicy.validateBinding({ ...input, childPolicy: { kind: "root_budget_inheritance_v1",
    maxConcurrent: 1, profiles: [input.profile] } }).ok).toBe(false)
  for (const key of ["maxTotalTokens", "maxInputTokens", "maxCompletionTokens", "maxProviderDispatches", "maxToolCalls", "maxChildren", "maxDurationMs"] as const)
    expect(WorkAuthorityPolicy.validateBinding({ ...input, budget: { ...input.budget, [key]: input.budget[key] + 1 } }).ok).toBe(false)
})

test("ninth turn and smaller grant limits reject before token count while project retains its policy", () => {
  const input = EventInvestigationFixture.binding()
  expect(WorkAuthorityPolicy.checkProviderTurn(input, 8).ok).toBe(true)
  const ninth = WorkAuthorityPolicy.checkProviderTurn(input, 9)
  expect(ninth.ok).toBe(false)
  if (!ninth.ok) expect(ninth.error.code).toBe("WORK_BUDGET_EXHAUSTED")
  expect(WorkAuthorityPolicy.checkProviderTurn({ ...input, budget: { ...input.budget, maxProviderDispatches: 2 } }, 3).ok).toBe(false)
  expect(WorkAuthorityPolicy.checkProviderTurn({ ...input, profile: { id: "project_work_v1", version: 1,
    hash: WorkAuthorityPolicy.PROJECT_PROFILE_HASH } }, 9).ok).toBe(true)
})
