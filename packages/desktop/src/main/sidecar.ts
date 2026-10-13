import * as http from "node:http"
import * as tls from "node:tls"
import { createSidecarShutdown } from "./sidecar-shutdown"
import { receiveWindowsNativeSidecar } from "./windows-native-sidecar-child"
import { rendererOrigin } from "./renderer-origin"

type NodeHttpWithEnvProxy = typeof http & {
  setGlobalProxyFromEnv: () => void
}

type NodeTlsWithSystemCertificates = typeof tls & {
  getCACertificates: (type: "default" | "system") => string[]
  setDefaultCACertificates: (certificates: string[]) => void
}

type StartCommand = {
  type: "start"
  hostname: string
  port: number
  password: string
  rendererOrigin?: string
}

type StopCommand = { type: "stop" }
type SidecarCommand = StartCommand | StopCommand

type SidecarMessage =
  | { type: "ready" }
  | { type: "managed-browser-bootstrap-ready-v1" }
  | { type: "managed-browser-ready-v1" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }

type ParentPort = {
  postMessage(message: SidecarMessage | { type: "dac-native-preload-challenge-v1"; birth: string }): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
  off(event: "message", listener: (event: { data: unknown }) => void): void
}

type Listener = {
  stop(close?: boolean): void | Promise<void>
}

const parentPort = getParentPort()
let listener: Listener | undefined
const stop = createSidecarShutdown({
  stop: () => listener?.stop(),
  clear: () => { listener = undefined },
  report: (message) => parentPort.postMessage(message),
  exit: (code) => { setImmediate(() => process.exit(code)) },
})

// The sealed Node entry captures its startup transport before Root/plugin loading.
// Complete trusted host preparation first so later start() does not retire that snapshot.
ensureLoopbackNoProxy()
useSystemCertificates()
useEnvProxy()

// Eagerly start loading the server module the instant the sidecar process
// starts — before the {type:"start"} message arrives from the main process.
// Module loading (parsing + JIT) takes 1-2 s; starting it here lets that
// work overlap with the main process's loadShellEnv + window creation, so
// by the time start() is called the import is already done or nearly done.
// Load the physical unpacked entry. Its signed bytes and adjacent assets must be
// verifiable through actual file descriptors, rather than Electron's virtual ASAR FS.
const serverURL = new URL("./chunks/node.js", import.meta.url)
serverURL.pathname = serverURL.pathname.replace("/app.asar/", "/app.asar.unpacked/")
const serverModulePromise = receiveWindowsNativeSidecar(parentPort).then(async (preloaded) => {
  const server = await import(/* @vite-ignore */ serverURL.href) as typeof import("virtual:deepagent-code-server")
  if (preloaded) await server.NativeWindowsBootstrap.installFixedEntry()
  return server
})
// The parent port must be installed before any Root or cached Location is constructed.
const nativeReady = serverModulePromise.then(({ BrowserNativeHost }) => BrowserNativeHost.prepare())
// Eager preparation can reject before the start message arrives. Keep the original rejection
// for start() to report, while avoiding an unhandled-rejection window during module loading.
void nativeReady.catch(() => {})

parentPort.on("message", (event) => {
  const command = parseCommand(event.data)
  if (!command) return
  if (command.type === "stop") {
    void stop()
    return
  }
  void start(command)
})

async function start(command: StartCommand) {
  try {
    prepareSidecarEnv(command.password)
    // Await the eagerly-started import — usually already done by now.
    const { Log, Server } = await serverModulePromise
    await nativeReady
    await Log.init({ level: "WARN" })

    listener = await Server.listen({
      port: command.port,
      hostname: command.hostname,
      username: "deepagent-code",
      password: command.password,
      cors: command.rendererOrigin ? ["oc://renderer", command.rendererOrigin] : ["oc://renderer"],
    })
    parentPort.postMessage({ type: "ready" })
  } catch (error) {
    parentPort.postMessage({ type: "error", error: serializeError(error) })
    setImmediate(() => process.exit(1))
  }
}

function prepareSidecarEnv(password: string) {
  Object.assign(process.env, {
    DEEPAGENT_CODE_SERVER_USERNAME: "deepagent-code",
    DEEPAGENT_CODE_SERVER_PASSWORD: password,
  })
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

function useSystemCertificates() {
  try {
    const nodeTls = tls as NodeTlsWithSystemCertificates
    nodeTls.setDefaultCACertificates([
      ...new Set([...nodeTls.getCACertificates("default"), ...nodeTls.getCACertificates("system")]),
    ])
  } catch (error) {
    console.warn("failed to load system certificates", error)
  }
}

function useEnvProxy() {
  try {
    ;(http as NodeHttpWithEnvProxy).setGlobalProxyFromEnv()
  } catch (error) {
    console.warn("failed to load proxy environment", error)
  }
}

function parseCommand(value: unknown): SidecarCommand | undefined {
  if (!value || typeof value !== "object") return
  const command = value as Partial<StartCommand | StopCommand>
  if (command.type === "stop") return { type: "stop" }
  if (command.type !== "start") return
  if (typeof command.hostname !== "string") return
  if (typeof command.port !== "number") return
  if (typeof command.password !== "string") return
  if (
    command.rendererOrigin !== undefined &&
    (typeof command.rendererOrigin !== "string" || rendererOrigin(command.rendererOrigin) !== command.rendererOrigin)
  ) return
  return {
    type: "start",
    hostname: command.hostname,
    port: command.port,
    password: command.password,
    rendererOrigin: command.rendererOrigin,
  }
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function getParentPort() {
  const port = process.parentPort as ParentPort | undefined
  if (!port) throw new Error("Sidecar parent port unavailable")
  return port
}
