import { utilityProcess } from "electron"
import { fileURLToPath } from "node:url"
import { installManagedBrowser } from "../managed-browser"
import { checkHealth } from "../server"
import { createSidecarStop } from "../sidecar-stop"

/** Test HTTP/Effect assembly only: no installed Windows cohort or Native witness. */
export async function spawnUnsealedCanonicalSidecar(root: string, port: number, password: string) {
  const child = utilityProcess.fork(fileURLToPath(new URL("./sidecar.js", import.meta.url)), [], {
    cwd: process.cwd(),
    env: { ...process.env, DAC_UNSEALED_TEST_ROOT: root, DEEPAGENT_CODE_TEST_HOME: root, DEEPAGENT_CODE_DISABLE_CHANNEL_DB: "1" },
    serviceName: "deepagent-code server",
    stdio: "pipe",
  })
  const exit = Promise.withResolvers<number>()
  const ready = Promise.withResolvers<void>()
  const state = { exited: false, installed: false }
  child.once("exit", (code) => {
    state.exited = true
    exit.resolve(code)
    ready.reject(new Error(`Unsealed unit sidecar exited before ready: ${code}`))
  })
  child.on("error", ready.reject)
  child.stdout?.on("data", (bytes: Buffer) => console.log(bytes.toString("utf8").trimEnd()))
  child.stderr?.on("data", (bytes: Buffer) => console.error(bytes.toString("utf8").trimEnd()))
  const onMessage = (message: unknown) => {
    if (!message || typeof message !== "object" || !("type" in message)) return
    if (message.type === "managed-browser-bootstrap-ready-v1" && !state.installed) {
      state.installed = true
      installManagedBrowser(child, password)
    }
    if (message.type === "ready") ready.resolve()
    if (message.type === "error") ready.reject(new Error(`Unsealed unit sidecar failed: ${JSON.stringify(message)}`))
  }
  child.on("message", onMessage)
  const stop = createSidecarStop({ postStop: () => child.postMessage({ type: "stop" }), kill: () => child.kill(),
    exit: exit.promise, hasExited: () => state.exited })
  const timer = setTimeout(() => ready.reject(new Error("Unsealed unit sidecar did not become ready")), 60_000)
  if (process.platform === "win32") child.postMessage({ type: "dac-native-preload-unavailable-v1" })
  child.postMessage({ type: "start", hostname: "127.0.0.1", port, password })
  try {
    await ready.promise
  } catch (error) {
    await stop()
    throw error
  } finally {
    clearTimeout(timer)
    child.off("message", onMessage)
    child.off("error", ready.reject)
  }
  return { listener: { stop }, health: { wait: (async () => {
    const deadline = Date.now() + 30_000
    while (!state.exited && Date.now() < deadline) {
      if (await checkHealth(`http://127.0.0.1:${port}`, password)) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error("Unsealed unit sidecar health unavailable")
  })() } }
}
