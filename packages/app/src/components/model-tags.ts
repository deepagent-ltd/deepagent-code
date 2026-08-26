export function showFreeModelTag(model: { cost?: { input: number }; provider: { id: string } }) {
  return model.provider.id === "deepagent-code" && model.cost?.input === 0
}
