import { Option } from "effect"
import * as Effect from "effect/Effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Daemon } from "../../../services/daemon"

export default Runtime.handler(
  Commands.commands.auth.commands.login,
  Effect.fn("cli.auth.login")(function* (input) {
    const provider = Option.getOrNull(input.provider)
    if (!provider) {
      const daemon = yield* Daemon.Service
      const client = yield* daemon.client()
      const result = yield* Effect.tryPromise(() => client.provider.list())
      const providers = result.data?.all ?? []
      if (providers.length === 0) {
        return yield* Effect.fail(new Error("No providers available. Start the daemon first."))
      }
      console.log("Available providers:")
      for (const p of providers.sort((a, b) => a.name.localeCompare(b.name))) {
        console.log(`  ${p.id} — ${p.name}`)
      }
      console.log('\nUsage: dacode auth login <provider> --key <api-key>')
      return
    }

    // Well-known URL flow: provider starts with http:// or https://
    if (provider.startsWith("http://") || provider.startsWith("https://")) {
      const url = provider.replace(/\/+$/, "")
      const wellknown = yield* Effect.tryPromise(() =>
        fetch(`${url}/.well-known/deepagent-code`).then(
          (r) => r.json() as Promise<{ auth: { command: string[]; env: string } }>,
        ),
      )

      console.log(`Running: ${wellknown.auth.command.join(" ")}`)
      const { spawn } = yield* Effect.promise(() => import("node:child_process"))
      const proc = spawn(wellknown.auth.command[0], wellknown.auth.command.slice(1), {
        stdio: ["inherit", "pipe", "inherit"],
      })

      const token = yield* Effect.promise(() => {
        return new Promise<string>((resolve, reject) => {
          let output = ""
          proc.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()))
          proc.on("close", (exit) => {
            if (exit !== 0) reject(new Error("Auth provider command failed"))
            else resolve(output.trim())
          })
          proc.on("error", reject)
        })
      })

      const daemon = yield* Daemon.Service
      const client = yield* daemon.client()
      yield* Effect.tryPromise(() =>
        client.auth.set({ providerID: url, auth: { type: "wellknown", key: wellknown.auth.env, token } }),
      )
      console.log(`Logged into ${url}`)
      return
    }

    // API key flow
    const keyFlag = Option.getOrNull(input.key)
    let apiKey = keyFlag
    if (!apiKey && !process.stdin.isTTY) {
      apiKey = (yield* Effect.promise(() => Bun.stdin.text())).trim()
    }
    if (!apiKey) {
      return yield* Effect.fail(
        new Error("API key required. Use --key <value> or pipe via stdin: echo 'key' | dacode auth login <provider>"),
      )
    }

    const daemon = yield* Daemon.Service
    const client = yield* daemon.client()
    yield* Effect.tryPromise(() =>
      client.auth.set({ providerID: provider, auth: { type: "api", key: apiKey } }),
    )
    console.log(`Credentials saved for ${provider}`)
  }),
)
