export function createDeepAgentAuthProvider(options) {
  globalThis.__deepagentAuthProviderOptions = options
  return {
    languageModel(modelID) {
      globalThis.__deepagentAuthProviderModelID = modelID
      return {
        specificationVersion: "v3",
        provider: "deepagent.test",
        modelId: modelID,
      }
    },
  }
}
