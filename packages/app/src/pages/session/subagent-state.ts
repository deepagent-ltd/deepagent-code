type SubagentMetadata = {
  finished?: boolean
  state?: string
  reason?: string
  interrupted?: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const subagentMetadata = (value?: unknown) => {
  if (!isRecord(value)) return undefined
  const metadata = isRecord(value.metadata) ? value.metadata : value
  const deepagent = isRecord(metadata.deepagent) ? metadata.deepagent : undefined
  const subagent = isRecord(deepagent?.subagent) ? deepagent.subagent : undefined
  if (!subagent) return undefined
  return {
    ...(typeof subagent.finished === "boolean" ? { finished: subagent.finished } : {}),
    ...(typeof subagent.state === "string" ? { state: subagent.state } : {}),
    ...(typeof subagent.reason === "string" ? { reason: subagent.reason } : {}),
    ...(typeof subagent.interrupted === "boolean" ? { interrupted: subagent.interrupted } : {}),
  } satisfies SubagentMetadata
}

/** Supports durable state markers, real Session records, and legacy boolean interruption markers. */
export const isSubagentInterrupted = (value?: unknown) => {
  const subagent = subagentMetadata(value)
  return subagent?.state === "interrupted" || subagent?.interrupted === true
}
