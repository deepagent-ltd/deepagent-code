import type { DeepAgentCodeClient, McpAppInvokeResponse } from "@deepagent-code/sdk"

type Status = McpAppInvokeResponse

/** Wait for the original invocation. Status reads never repeat admission or dispatch. */
export async function invokeMcpApp(input: {
  client: DeepAgentCodeClient
  directory: string
  sessionID: string
  viewID: string
  rpcID: string | number
  name: string
  arguments: Record<string, unknown>
  signal: AbortSignal
  current: () => boolean
  subscribe: (changed: (status: Status) => void) => () => void
  observed: (status: Status) => void
}) {
  const { Schema } = await import("effect")
  const { McpAppInvocationSchema } = await import("@deepagent-code/core/session/mcp-app-invocation.schema")
  const args = Schema.decodeUnknownSync(McpAppInvocationSchema.Arguments)(input.arguments)
  if (input.signal.aborted || !input.current()) throw new Error("MCP App view changed")
  const terminal = (status: Status) =>
    ["settled", "failed", "cancelled_before_dispatch", "unknown"].includes(status.state)
  const waiting: { invocationID?: string; latest?: Status; complete?: (status?: Status) => void } = {}
  const changed = new Promise<Status | undefined>((resolve) => {
    waiting.complete = resolve
  })
  const unsubscribe = input.subscribe((status) => {
    if (status.sessionID !== input.sessionID || status.viewID !== input.viewID || !Object.is(status.rpcID, input.rpcID))
      return
    if (waiting.invocationID && status.invocationID !== waiting.invocationID) return
    waiting.latest = status
    if (input.current()) input.observed(status)
    if (terminal(status)) waiting.complete?.(status)
  })
  const abort = () => waiting.complete?.()
  input.signal.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(abort, 60000)
  try {
    const admitted = await input.client.mcp
      .appInvoke(
        {
          directory: input.directory,
          sessionID: input.sessionID,
          viewID: input.viewID,
          rpcID: input.rpcID,
          name: input.name,
          arguments: args,
        },
        { signal: input.signal },
      )
      .then((response) => response.data)
    if (
      !admitted ||
      admitted.sessionID !== input.sessionID ||
      admitted.viewID !== input.viewID ||
      !Object.is(admitted.rpcID, input.rpcID)
    )
      throw new Error("MCP App invocation admission is unavailable")
    waiting.invocationID = admitted.invocationID
    input.observed(admitted)
    const latest = waiting.latest?.invocationID === admitted.invocationID ? waiting.latest : admitted
    const observed = terminal(latest) ? latest : await changed
    if (input.signal.aborted || !input.current()) throw new Error("MCP App view changed")
    // One exact read also covers a lost status notification. It cannot start another tool call.
    const status =
      observed ??
      (await input.client.mcp
        .appInvocationStatus(
          { directory: input.directory, sessionID: input.sessionID, invocationID: admitted.invocationID },
          { signal: input.signal },
        )
        .then((response) => response.data))
    if (
      !status ||
      status.invocationID !== admitted.invocationID ||
      status.state !== "settled" ||
      !status.resultAvailable
    )
      throw new Error("MCP App invocation has no available result")
    input.observed(status)
    const result = await input.client.mcp
      .appInvocationResult(
        {
          directory: input.directory,
          sessionID: input.sessionID,
          viewID: input.viewID,
          invocationID: admitted.invocationID,
        },
        { signal: input.signal },
      )
      .then((response) => response.data)
    if (
      input.signal.aborted ||
      !input.current() ||
      !result ||
      result.invocationID !== admitted.invocationID ||
      result.sessionID !== input.sessionID ||
      result.viewID !== input.viewID ||
      result.state !== "settled" ||
      result.resultHash !== status.resultHash
    )
      throw new Error("MCP App result no longer belongs to the current view")
    return result.result
  } finally {
    clearTimeout(timer)
    input.signal.removeEventListener("abort", abort)
    unsubscribe()
  }
}
