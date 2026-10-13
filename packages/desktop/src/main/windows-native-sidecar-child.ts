import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

export type WindowsNativeSidecarPort = Readonly<{
  capture: object
  prepareWorkRuntime(capture: object): string
  prepareSidecar(capture: object): object
  bindSidecar(capture: object, lease: object, pid: number, birth: string): string
  closeSidecar(capture: object, lease: object): void
  processBirth(capture: object): string
  acceptPreload(capture: object, marker: string): boolean
  preloaded(capture: object): boolean
  current(capture: object): boolean
}>
type Port = {
  postMessage(message: { type: "dac-native-preload-challenge-v1"; birth: string }): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
  off(event: "message", listener: (event: { data: unknown }) => void): void
}

/** Call before importing the sealed node.js, while installing the ordinary
 * start/stop listener synchronously. The Main receipt uses the original port. */
export function receiveWindowsNativeSidecar(port: Port) {
  if (process.platform !== "win32") return Promise.resolve(false)
  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => fail("receipt-timeout"), 5_000)
    const state: { original?: WindowsNativeSidecarPort; received: boolean } = { received: false }
    const onMessage = (event: { data: unknown }) => {
      const message = event.data
      if (!message || typeof message !== "object" || !("type" in message)) return
      if (message.type === "dac-native-preload-unavailable-v1" && !state.original) {
        cleanup()
        resolve(false)
        return
      }
      if (message.type === "dac-native-preload-prepare-v1") {
        if (state.original || state.received) return fail("duplicate-prepare")
        try {
          const addonURL = new URL("./chunks/native-image-factory.node", import.meta.url)
          addonURL.pathname = addonURL.pathname.replace("/app.asar/", "/app.asar.unpacked/")
          const original = createRequire(import.meta.url)(fileURLToPath(addonURL)) as WindowsNativeSidecarPort
          if (!Object.isFrozen(original) || typeof original.processBirth !== "function" || typeof original.acceptPreload !== "function" ||
            typeof original.preloaded !== "function" || !original.current(original.capture) || original.preloaded(original.capture)) return fail("original-entry")
          state.original = original
          port.postMessage({ type: "dac-native-preload-challenge-v1", birth: original.processBirth(original.capture) })
        } catch { fail("capture") }
        return
      }
      if (message.type !== "dac-native-preload-receipt-v1") return
      if (!state.original || state.received || !("marker" in message) || typeof message.marker !== "string" ||
        !/^[0-9a-f]+(:[0-9a-f]+){5}$/.test(message.marker) || message.marker.length > 128) return fail("receipt-shape")
      state.received = true
      try {
        if (!state.original.acceptPreload(state.original.capture, message.marker) ||
          !state.original.preloaded(state.original.capture) || !state.original.current(state.original.capture)) return fail("receipt-current")
        cleanup()
        resolve(true)
      } catch { fail("receipt-native") }
    }
    const cleanup = () => { clearTimeout(timer); port.off("message", onMessage) }
    const fail = (stage: string) => {
      cleanup()
      reject(Object.assign(new Error(`Windows native sidecar bootstrap unavailable (${stage})`), {
        code: "WINDOWS_FIRST_LOADER_UNAVAILABLE", stage,
      }))
    }
    port.on("message", onMessage)
  })
}
