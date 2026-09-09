import { Effect } from "effect"
import { UI } from "../ui"
import { CliError, effectCmd } from "../effect-cmd"
import { isLoopbackHost, withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@deepagent-code/core/flag/flag"
import open from "open"
import { networkInterfaces } from "os"
import { Installation } from "@/installation"
import { spawn, type ChildProcess } from "node:child_process"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"

function getNetworkIPs() {
  const nets = networkInterfaces()
  const results: string[] = []

  for (const name of Object.keys(nets)) {
    const net = nets[name]
    if (!net) continue

    for (const netInfo of net) {
      // Skip internal and non-IPv4 addresses
      if (netInfo.internal || netInfo.family !== "IPv4") continue

      // Skip Docker bridge networks (typically 172.x.x.x)
      if (netInfo.address.startsWith("172.")) continue

      results.push(netInfo.address)
    }
  }

  return results
}

function connectHost(hostname: string) {
  return hostname === "0.0.0.0" ? "127.0.0.1" : hostname
}

function canConnect(hostname: string, port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: hostname, port })
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", () => {
      socket.destroy()
      resolve(false)
    })
    socket.setTimeout(500, () => {
      socket.destroy()
      resolve(false)
    })
  })
}

async function findAvailablePort(hostname: string, start = 3000) {
  for (let port = start; port < start + 100; port++) {
    if (!(await canConnect(hostname, port))) return port
  }
  throw new Error(`No available local web UI port found from ${start} to ${start + 99}.`)
}

async function waitForPort(hostname: string, port: number, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await canConnect(hostname, port)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for local web UI at http://${hostname}:${port}.`)
}

function startLocalWebUI(input: { serverHost: string; serverPort: number; appHost: string; appPort: number }) {
  const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../app")
  const child = spawn(
    process.execPath,
    ["run", "dev", "--", "--host", input.appHost, "--port", String(input.appPort), "--strictPort"],
    {
      cwd: appDir,
      stdio: "inherit",
      env: {
        ...process.env,
        VITE_DEEPAGENT_CODE_SERVER_HOST: input.serverHost,
        VITE_DEEPAGENT_CODE_SERVER_PORT: String(input.serverPort),
      },
    },
  )
  child.on("error", (error) => UI.error(`Failed to start local DeepAgent web UI: ${error.message}`))
  return child
}

function waitForShutdown(child?: ChildProcess) {
  return Effect.callback<void>((resume) => {
    const stop = () => resume(Effect.void)
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
    process.once("SIGHUP", stop)
    child?.once("exit", stop)
    return Effect.sync(() => {
      process.off("SIGINT", stop)
      process.off("SIGTERM", stop)
      process.off("SIGHUP", stop)
      child?.off("exit", stop)
    })
  })
}

function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      child.off("exit", done)
      resolve()
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      done()
    }, 2_000)
    child.once("exit", done)
    child.kill("SIGTERM")
  })
}

export const WebCommand = effectCmd({
  command: "web",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "start deepagent-code server and open web interface",
  // Server loads instances per-request via x-deepagent-code-directory header — no
  // ambient project InstanceContext needed at startup.
  instance: false,
  // Same single-database-owner contract as `serve` (see effectCmd's `standalone`).
  standalone: true,
  handler: Effect.fn("Cli.web")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    const baseOpts = yield* resolveNetworkOptions(args)
    if (!Flag.DEEPAGENT_CODE_SERVER_PASSWORD) {
      // G7i security F1: never serve unauthenticated on a non-loopback bind.
      if (!isLoopbackHost(baseOpts.hostname)) {
        return yield* Effect.fail(
          new CliError({
            message:
              "Refusing to serve unauthenticated on a non-loopback host; set DEEPAGENT_CODE_SERVER_PASSWORD or bind --hostname 127.0.0.1/::1",
            exitCode: 2,
          }),
        )
      }
      UI.println(UI.Style.TEXT_WARNING_BOLD + "!  DEEPAGENT_CODE_SERVER_PASSWORD is not set; server is unsecured (loopback only).")
    }
    const appHost = "127.0.0.1"
    const appPort = Installation.isLocal()
      ? yield* Effect.promise(() => findAvailablePort(appHost, Number(process.env.DEEPAGENT_WEB_UI_PORT ?? 3000)))
      : undefined
    const opts =
      appPort === undefined
        ? baseOpts
        : {
            ...baseOpts,
            cors: [...baseOpts.cors, `http://127.0.0.1:${appPort}`, `http://localhost:${appPort}`],
          }
    return yield* Effect.acquireUseRelease(
      Effect.promise(() => Server.listen(opts)),
      (server) =>
        Effect.gen(function* () {
          UI.empty()
          UI.println(UI.logo("  "))
          UI.empty()

          if (appPort !== undefined) {
            return yield* Effect.acquireUseRelease(
              Effect.sync(() =>
                startLocalWebUI({
                  serverHost: connectHost(server.hostname),
                  serverPort: server.port,
                  appHost,
                  appPort,
                }),
              ),
              (child) =>
                Effect.gen(function* () {
                  const appUrl = `http://${appHost}:${appPort}`
                  yield* Effect.promise(() => waitForPort(appHost, appPort))
                  UI.println(
                    UI.Style.TEXT_INFO_BOLD + "  Backend:          ",
                    UI.Style.TEXT_NORMAL,
                    server.url.toString(),
                  )
                  UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, appUrl)
                  open(appUrl).catch(() => {})
                  return yield* waitForShutdown(child)
                }),
              (child) => Effect.promise(() => stopChild(child)),
            )
          }

          if (opts.hostname === "0.0.0.0") {
            const localhostUrl = `http://localhost:${server.port}`
            UI.println(UI.Style.TEXT_INFO_BOLD + "  Local access:      ", UI.Style.TEXT_NORMAL, localhostUrl)
            getNetworkIPs().forEach((ip) =>
              UI.println(
                UI.Style.TEXT_INFO_BOLD + "  Network access:    ",
                UI.Style.TEXT_NORMAL,
                `http://${ip}:${server.port}`,
              ),
            )
            if (opts.mdns) {
              UI.println(
                UI.Style.TEXT_INFO_BOLD + "  mDNS:              ",
                UI.Style.TEXT_NORMAL,
                `${opts.mdnsDomain}:${server.port}`,
              )
            }
            open(localhostUrl).catch(() => {})
            return yield* waitForShutdown()
          }

          const displayUrl = server.url.toString()
          UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, displayUrl)
          open(displayUrl).catch(() => {})
          return yield* waitForShutdown()
        }),
      (server) => Effect.promise(() => server.stop(true)),
    )
  }),
})
