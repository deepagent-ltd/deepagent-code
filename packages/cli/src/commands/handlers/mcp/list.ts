import { EOL } from "os"
import * as Effect from "effect/Effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Daemon } from "../../../services/daemon"

export default Runtime.handler(
  Commands.commands.mcp.commands.list,
  Effect.fn("cli.mcp.list")(function* () {
    const daemon = yield* Daemon.Service
    const client = yield* daemon.client()
    const result = yield* Effect.tryPromise(() => client.mcp.status())
    const statuses = result.data ?? {}

    const entries = Object.entries(statuses)
    if (entries.length === 0) {
      console.log("No MCP servers configured.")
      console.log("Add servers with: dacode mcp add <name> --url <url>")
      return
    }

    for (const [name, status] of entries) {
      const icon = statusIcon(status.status)
      const text = statusText(status.status)
      const hint = "error" in status ? ` — ${status.error}` : ""
      process.stdout.write(`${icon} ${name} ${text}${hint}${EOL}`)
    }

    process.stdout.write(`${EOL}${entries.length} server(s)${EOL}`)
  }),
)

function statusIcon(status: string): string {
  switch (status) {
    case "connected":
      return "✓"
    case "disabled":
      return "○"
    case "needs_auth":
      return "⚠"
    case "needs_client_registration":
      return "✗"
    default:
      return "✗"
  }
}

function statusText(status: string): string {
  switch (status) {
    case "connected":
      return "connected"
    case "disabled":
      return "disabled"
    case "needs_auth":
      return "needs authentication"
    case "needs_client_registration":
      return "needs client registration"
    case "failed":
      return "failed"
    default:
      return status
  }
}
