type SubagentMetadata = {
  state?: string
  interrupted?: boolean
}

/** Supports durable state markers and legacy boolean interruption markers. */
export const isInterruptedSubagent = (metadata?: Record<string, unknown>) => {
  const subagent = (metadata?.["deepagent"] as { subagent?: SubagentMetadata } | undefined)?.subagent
  return subagent?.state === "interrupted" || subagent?.interrupted === true
}
