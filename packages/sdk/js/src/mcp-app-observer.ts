import type { DeepAgentCodeClient, McpAppInvokeResponse } from "./client.js"

/** A bounded, read-only observer. Notifications invalidate status; they never dispatch work. */
export function observeMcpAppInvocations(input: {
  client: DeepAgentCodeClient
  directory?: string
  sessionID: string
  current: () => boolean
  subscribe: (changed: (status: McpAppInvokeResponse) => void) => () => void
  changed: (statuses: readonly McpAppInvokeResponse[]) => void
  unavailable: () => void
}) {
  const state = { live: true, loading: false, again: false, abort: new AbortController() }
  const refresh = async () => {
    if (!state.live || !input.current()) return
    if (state.loading) {
      state.again = true
      return
    }
    state.loading = true
    state.again = false
    const result = await input.client.mcp
      .appInvocationList(
        { directory: input.directory, sessionID: input.sessionID, limit: 64 },
        { signal: AbortSignal.any([state.abort.signal, AbortSignal.timeout(10000)]) },
      )
      .then(
        (response) => response.data,
        () => undefined,
      )
    state.loading = false
    if (!state.live || !input.current()) return
    if (result && result.length <= 64 && result.every((status) => status.sessionID === input.sessionID))
      input.changed(result.slice().sort((a, b) => b.admittedSeq - a.admittedSeq))
    else input.unavailable()
    if (state.again) void refresh()
  }
  const unsubscribe = input.subscribe((status) => {
    if (status.sessionID === input.sessionID) void refresh()
  })
  return {
    refresh,
    close() {
      state.live = false
      state.again = false
      state.abort.abort()
      unsubscribe()
    },
  }
}
