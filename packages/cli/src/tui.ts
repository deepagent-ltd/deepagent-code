import { run } from "@deepagent-code/tui"
import type { Args } from "@deepagent-code/tui/context/args"
import { TuiConfig } from "@deepagent-code/tui/config"
import { Effect } from "effect"
import { Global } from "@deepagent-code/core/global"

export function runTui(
  transport: { url: string; headers: RequestInit["headers"] },
  args: Args,
  directory?: string,
) {
  const config = TuiConfig.resolve({}, { terminalSuspend: false })
  return run({
    ...transport,
    args,
    config,
    directory,
    fetch: gracefulFetch,
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

const gracefulFetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetch(input, init)
    if (response.status !== 404) return response
    const fallback = legacyDefaults[new URL(input instanceof Request ? input.url : input).pathname]
    if (fallback === undefined) return response
    return Response.json(fallback)
  },
  { preconnect: fetch.preconnect },
)
