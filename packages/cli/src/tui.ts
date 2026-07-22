import { run } from "@deepagent-code/tui"
import { TuiConfig } from "@deepagent-code/tui/config"
import { Effect } from "effect"
import { Global } from "@deepagent-code/core/global"

export function runTui(transport: {
  url: string
  headers: RequestInit["headers"]
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}) {
  const config = TuiConfig.resolve({}, { terminalSuspend: false })
  return run({
    ...transport,
    args: {},
    config,
    fetch: gracefulFetch(transport.fetch ?? fetch),
    pluginHost: {
      async start() {},
      async dispose() {},
    },
  }).pipe(Effect.provide(Global.defaultLayer))
}

const legacyDefaults: Record<string, unknown> = {
  "/config/providers": { providers: [], default: {} },
  "/provider": { all: [], default: {}, connected: [] },
  "/agent": [],
  "/config": {},
}

const gracefulFetch = (base: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
  Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await base(input, init)
      if (response.status !== 404) return response
      const fallback = legacyDefaults[new URL(input instanceof Request ? input.url : input).pathname]
      if (fallback === undefined) return response
      return Response.json(fallback)
    },
    { preconnect: fetch.preconnect },
  )
