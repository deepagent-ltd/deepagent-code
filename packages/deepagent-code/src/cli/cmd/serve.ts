import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@deepagent-code/core/flag/flag"
import { Global } from "@deepagent-code/core/global"
import { InstallationVersion } from "@deepagent-code/core/installation/version"
import { randomUUID } from "node:crypto"
import fsSync from "node:fs"
import path from "node:path"

// PARITY-003 (Wave 0): lets the new CLI daemon mount this legacy server. Mirrors Daemon.register
// (packages/cli/src/services/daemon.ts) — atomic state/server.json write, 10s heartbeat that
// self-terminates when superseded, and file removal on shutdown while we still own it. Plain Node
// on purpose: the legacy CLI must not depend on the new cli package.
function registerWithDaemon(url: string, stop: () => Promise<void>) {
  const file = path.join(Global.Path.state, "server.json")
  const id = randomUUID()
  const read = (): { id?: string } | undefined => {
    try {
      return JSON.parse(fsSync.readFileSync(file, "utf8"))
    } catch {
      return undefined
    }
  }
  const owned = () => read()?.id === id
  fsSync.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${id}.tmp`
  fsSync.writeFileSync(temp, JSON.stringify({ id, version: InstallationVersion, url, pid: process.pid }), {
    mode: 0o600,
  })
  fsSync.renameSync(temp, file)

  const heartbeat = setInterval(() => {
    // Another server took over the registration — the daemon moved on, step down.
    if (!owned()) process.kill(process.pid, "SIGTERM")
  }, 10_000)
  heartbeat.unref()

  let exiting = false
  const shutdown = () => {
    if (exiting) return
    exiting = true
    clearInterval(heartbeat)
    if (owned()) {
      try {
        fsSync.unlinkSync(file)
      } catch {
        // A concurrent takeover may have already replaced the file.
      }
    }
    void stop().finally(() => process.exit(0))
    // Hard ceiling so a stuck graceful stop cannot outlive the daemon's SIGKILL budget.
    setTimeout(() => process.exit(0), 2_000).unref()
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
}

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) =>
    withNetworkOptions(yargs).option("register", {
      type: "boolean" as const,
      default: false,
      describe: "register this server with the local CLI daemon (writes state/server.json)",
    }),
  describe: "starts a headless deepagent-code server",
  // Server loads instances per-request via x-deepagent-code-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    if (!Flag.DEEPAGENT_CODE_SERVER_PASSWORD) {
      console.log("Warning: DEEPAGENT_CODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`deepagent-code server listening on http://${server.hostname}:${server.port}`)

    if (args.register) {
      registerWithDaemon(`http://${server.hostname}:${server.port}`, () => server.stop(true))
    }

    yield* Effect.never
  }),
})
