import { expect, test } from "bun:test"
import { OpenAICompatibleResponses, OpenAIResponses } from "@deepagent-code/llm/protocols"
import { WorkProviderContract } from "../../src/installation/work-provider-contract"

const approved = {
  providerID: "deepseek", modelID: "deepseek-flash", protocol: "openai-responses" as const,
  configurationStamp: "a".repeat(64), configuredTargetStamp: "b".repeat(64),
}
const lowered = OpenAICompatibleResponses.route.with({ provider: approved.providerID,
  endpoint: { baseURL: "https://api.deepseek.com" } }).model({ id: approved.modelID })
const actual = {
  providerID: lowered.provider, modelID: lowered.id, adapterID: lowered.route.id, protocol: lowered.route.protocol,
  configurationStamp: approved.configurationStamp, configuredTargetStamp: approved.configuredTargetStamp,
}

test("reviewed DeepSeek family accepts its actual compatible Responses adapter", () => {
  expect(lowered.route.id).toBe("openai-compatible-responses")
  expect(WorkProviderContract.runtimeMismatch(approved, actual)).toEqual([])
})

test("original OpenAI family retains its official Responses adapter and rejects cross-family adapters", () => {
  const evidence = { ...approved, providerID: "openai", modelID: "gpt-4.1-2025-04-14" }
  const model = OpenAIResponses.route.model({ id: evidence.modelID })
  const value = { ...actual, providerID: model.provider, modelID: model.id, adapterID: model.route.id }
  expect(model.route.id).toBe("openai-responses")
  expect(WorkProviderContract.runtimeMismatch(evidence, value)).toEqual([])
  expect(WorkProviderContract.runtimeMismatch(approved, { ...actual, adapterID: model.route.id })).toEqual(["adapterID"])
  expect(WorkProviderContract.runtimeMismatch(evidence, { ...value, adapterID: lowered.route.id })).toEqual(["adapterID"])
})

test("unknown family and changed Native identity remain closed with fixed safe field diagnostics", () => {
  expect(WorkProviderContract.runtimeMismatch({ ...approved, modelID: "deepseek-other" },
    { ...actual, modelID: "deepseek-other" }).sort()).toEqual(["adapterID", "contract"])
  expect(WorkProviderContract.runtimeMismatch(approved, { ...actual, providerID: "other", modelID: "other",
    protocol: "openai-chat", configurationStamp: "c".repeat(64), configuredTargetStamp: "d".repeat(64) })).toEqual([
    "providerID", "modelID", "protocol", "configurationStamp", "configuredTargetStamp",
  ])
})

test("runtime evidence projection retains the actual reviewed lowering route ID", () => {
  const evidence = { ...approved, modelRevision: "reviewed-alias", adapterHash: "c".repeat(64),
    loweringHash: "d".repeat(64), framingHash: "e".repeat(64) }
  const compatible = WorkProviderContract.projectRuntime(evidence)
  expect(compatible?.routeID).toBe(lowered.route.id)
  expect(lowered.route.protocol).toBe(compatible?.protocol ?? "")
  const official = OpenAIResponses.route.model({ id: "gpt-4.1-2025-04-14" })
  expect(WorkProviderContract.projectRuntime({ ...evidence, providerID: official.provider, modelID: official.id })?.routeID).toBe(official.route.id)
  expect(WorkProviderContract.projectRuntime({ ...evidence, modelID: "deepseek-other" })).toBeUndefined()
})
