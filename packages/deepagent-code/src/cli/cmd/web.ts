import { Effect } from "effect"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
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

function cleanupChild(child: ChildProcess) {
  const stop = () => {
    if (child.killed) return
    child.kill("SIGTERM")
  }
  process.once("exit", stop)
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  process.once("SIGHUP", stop)
}

export const WebCommand = effectCmd({
  command: "web",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "start deepagent-code server and open web interface",
  // Server loads instances per-request via x-deepagent-code-directory header — no
  // ambient project InstanceContext needed at startup.
  instance: false,
  handler: Effect.fn("Cli.web")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    if (!Flag.DEEPAGENT_CODE_SERVER_PASSWORD) {
      UI.println(UI.Style.TEXT_WARNING_BOLD + "!  DEEPAGENT_CODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const baseOpts = yield* resolveNetworkOptions(args)
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
    const server = yield* Effect.promise(() => Server.listen(opts))
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()

    if (appPort !== undefined) {
      const serverHost = connectHost(server.hostname)
      const child = startLocalWebUI({ serverHost, serverPort: server.port, appHost, appPort })
      cleanupChild(child)
      const appUrl = `http://${appHost}:${appPort}`
      yield* Effect.promise(() => waitForPort(appHost, appPort))
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Backend:          ", UI.Style.TEXT_NORMAL, server.url.toString())
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, appUrl)
      open(appUrl).catch(() => {})
      yield* Effect.never
      return
    }

    if (opts.hostname === "0.0.0.0") {
      // Show localhost for local access
      const localhostUrl = `http://localhost:${server.port}`
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Local access:      ", UI.Style.TEXT_NORMAL, localhostUrl)

      // Show network IPs for remote access
      const networkIPs = getNetworkIPs()
      if (networkIPs.length > 0) {
        for (const ip of networkIPs) {
          UI.println(
            UI.Style.TEXT_INFO_BOLD + "  Network access:    ",
            UI.Style.TEXT_NORMAL,
            `http://${ip}:${server.port}`,
          )
        }
      }

      if (opts.mdns) {
        UI.println(
          UI.Style.TEXT_INFO_BOLD + "  mDNS:              ",
          UI.Style.TEXT_NORMAL,
          `${opts.mdnsDomain}:${server.port}`,
        )
      }

      // Open localhost in browser
      open(localhostUrl).catch(() => {})
    } else {
      const displayUrl = server.url.toString()
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, displayUrl)
      open(displayUrl).catch(() => {})
    }

    yield* Effect.never
  }),
})
