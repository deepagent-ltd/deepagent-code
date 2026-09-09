import { Effect } from "effect"
import { CliError, effectCmd } from "../effect-cmd"
import { isLoopbackHost, withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@deepagent-code/core/flag/flag"
import { Global } from "@deepagent-code/core/global"
import { InstallationVersion } from "@deepagent-code/core/installation/version"
import { randomUUID } from "node:crypto"
import fsSync from "node:fs"
import path from "node:path"

// Atomic daemon registration with a heartbeat that asks the owning Effect to stop when superseded.
// The caller owns signal handling and server/runtime finalization.
function registerWithDaemon(url: string, shutdown: () => void) {
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
    if (!owned()) shutdown()
  }, 10_000)
  heartbeat.unref()

  return () => {
    clearInterval(heartbeat)
    if (owned()) {
      try {
        fsSync.unlinkSync(file)
      } catch {
        // A concurrent takeover may have already replaced the file.
      }
    }
  }
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
  // Server.listen preflights, opens, migrates, and lifetime-locks the database itself; it must
  // be the ONLY database owner in this process (see effectCmd's `standalone` contract).
  standalone: true,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    const opts = yield* resolveNetworkOptions(args)
    if (!Flag.DEEPAGENT_CODE_SERVER_PASSWORD) {
      // G7i security F1: never serve unauthenticated on a non-loopback bind.
      if (!isLoopbackHost(opts.hostname)) {
        return yield* Effect.fail(
          new CliError({
            message:
              "Refusing to serve unauthenticated on a non-loopback host; set DEEPAGENT_CODE_SERVER_PASSWORD or bind --hostname 127.0.0.1/::1",
            exitCode: 2,
          }),
        )
      }
      console.log("Warning: DEEPAGENT_CODE_SERVER_PASSWORD is not set; server is unsecured (loopback only).")
    }
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`deepagent-code server listening on http://${server.hostname}:${server.port}`)

    // Effect.callback's canceler only runs on interruption; the graceful
    // SIGTERM/SIGINT path resumes normally and would skip it. Keep the canceler
    // for interruption and repeat cleanup in `ensuring` (idempotent) so the
    // daemon registration is removed on every exit.
    let cleanup = () => {}
    yield* Effect.callback<void, never>((resume) => {
      let stopping = false
      const shutdown = () => {
        if (stopping) return
        stopping = true
        resume(Effect.void)
      }
      const unregister = args.register
        ? registerWithDaemon(`http://${server.hostname}:${server.port}`, shutdown)
        : () => {}
      cleanup = () => {
        process.off("SIGTERM", shutdown)
        process.off("SIGINT", shutdown)
        unregister()
      }
      process.on("SIGTERM", shutdown)
      process.on("SIGINT", shutdown)
      return Effect.sync(() => cleanup())
    }).pipe(
      Effect.ensuring(Effect.sync(() => cleanup())),
      Effect.ensuring(Effect.promise(() => server.stop(true))),
    )
  }),
})
