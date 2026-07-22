import { run } from "@deepagent-code/tui"
import { TuiConfig } from "@deepagent-code/tui/config"
import { Effect } from "effect"
import { Global } from "@deepagent-code/core/global"
import { gracefulFetch } from "./services/graceful-fetch"

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
