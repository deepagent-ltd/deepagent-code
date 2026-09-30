export function promptIntelligenceMode(input: {
  configMode?: unknown
  overrides: Record<string, boolean>
  sessionID?: string
  directory?: string
}) {
  const session = input.sessionID ? input.overrides[input.sessionID] : undefined
  return session ?? input.overrides[`directory:${input.directory ?? ""}`] ?? input.configMode !== "direct"
}
