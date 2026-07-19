import { Option } from "effect"
import * as Effect from "effect/Effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Daemon } from "../../../services/daemon"

type McpLocalConfig = { type: "local"; command: string[]; environment?: Record<string, string> }
type McpRemoteConfig = { type: "remote"; url: string; headers?: Record<string, string> }
type McpConfig = McpLocalConfig | McpRemoteConfig

function parseEntries(value: string, kind: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const entry of value.split(",")) {
    const idx = entry.indexOf("=")
    if (idx < 1) throw new Error(`Invalid ${kind}: ${entry}. Expected KEY=VALUE`)
    result[entry.slice(0, idx)] = entry.slice(idx + 1)
  }
  return result
}

export default Runtime.handler(
  Commands.commands.mcp.commands.add,
  Effect.fn("cli.mcp.add")(function* (input) {
    const url = Option.getOrNull(input.url)
    const command = Option.getOrNull(input.command)

    if (url && command) return yield* Effect.fail(new Error("Provide either --url <url> or --command <cmd>, not both"))
    if (!url && !command)
      return yield* Effect.fail(
        new Error("Provide --url <url> for a remote server or --command <cmd> for a local server"),
      )

    const envRaw = Option.getOrNull(input.env)
    const headerRaw = Option.getOrNull(input.header)

    const config: McpConfig = url
      ? { type: "remote", url, ...(headerRaw ? { headers: parseEntries(headerRaw, "HTTP header") } : {}) }
      : {
          type: "local",
          command: command!.split(" "),
          ...(envRaw ? { environment: parseEntries(envRaw, "environment variable") } : {}),
        }

    // Persist to global config via daemon — updateGlobal does a deep merge and
    // preserves comments in the .jsonc file, then disposes instances so the
    // new MCP server is picked up on the next request.
    const daemon = yield* Daemon.Service
    const client = yield* daemon.client()
    yield* Effect.tryPromise(() => client.global.config.update({ config: { mcp: { [input.name]: config } } }))
    console.log(`MCP server "${input.name}" added to global config`)
  }),
)
