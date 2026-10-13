import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import type { UtilityProcess } from "electron"
import type { WindowsNativeSidecarPort } from "./windows-native-sidecar-child"

const addonURL = new URL("./chunks/native-image-factory.node", import.meta.url)
addonURL.pathname = addonURL.pathname.replace("/app.asar/", "/app.asar.unpacked/")
// A failed native retirement keeps its original External alive until Main's
// native environment closes. It cannot be recovered from a new descriptor.
const retained = new Set<() => void>()

/** Main is the fixed initial launcher TCB. Prepare holds the exact signed
 * sidecar/node/addon cohort before the original utilityProcess is created. */
export function prepareWindowsNativeSidecar() {
  if (process.platform !== "win32") return undefined
  const original = capture()
  if (!original) return undefined
  if (!original.current(original.capture) || original.preloaded(original.capture)) throw failure("parent-current")
  // Installers extract file bytes without the publisher's build-directory ACL.
  // Prepare the fixed inventoried public runtime before immutable child leases.
  original.prepareWorkRuntime(original.capture)
  if (!original.current(original.capture) || original.preloaded(original.capture)) throw failure("runtime-preparation")
  const lease = original.prepareSidecar(original.capture)
  const state = { active: true, bound: false }
  return Object.freeze({
    bind(child: UtilityProcess) {
      if (!state.active || state.bound) throw failure("parent-lifetime")
      state.bound = true
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => fail(failure("challenge-timeout")), 5_000)
        const onExit = () => {
          clearTimeout(timer)
          child.off("message", onMessage)
          retire()
          reject(failure("child-exited"))
        }
        const onMessage = (message: unknown) => {
          if (!message || typeof message !== "object" || !("type" in message) || message.type !== "dac-native-preload-challenge-v1") return
          if (!("birth" in message) || typeof message.birth !== "string" || !/^[0-9a-f]{16}$/.test(message.birth) ||
            !state.active || !child.pid) return fail(failure("child-challenge"))
          try {
            const marker = original.bindSidecar(original.capture, lease, child.pid, message.birth)
            if (!/^[0-9a-f]+(:[0-9a-f]+){5}$/.test(marker) || marker.length > 128) throw failure("native-transfer")
            child.postMessage({ type: "dac-native-preload-receipt-v1", marker })
            clearTimeout(timer)
            child.off("message", onMessage)
            child.off("exit", onExit)
            child.once("exit", retire)
            resolve()
          } catch (error) { fail(error) }
        }
        const fail = (error: unknown) => {
          clearTimeout(timer)
          child.off("message", onMessage)
          child.off("exit", onExit)
          child.kill()
          child.once("exit", retire)
          reject(error)
        }
        child.on("message", onMessage)
        child.once("exit", onExit)
        child.postMessage({ type: "dac-native-preload-prepare-v1" })
      })
    },
    close,
  })
  function close() {
    if (!state.active) return
    // An active original child is never forgotten. Native close refuses until
    // its held process object has exited; failures retain this exact lease.
    original!.closeSidecar(original!.capture, lease)
    state.active = false
    retained.delete(close)
  }
  function retire() {
    try { close() } catch {
      retained.add(close)
      console.warn("Windows native sidecar retirement unavailable (original-join)")
    }
  }
}

function capture() {
  const original: unknown = createRequire(import.meta.url)(fileURLToPath(addonURL))
  if (!original || typeof original !== "object" || !Object.isFrozen(original) || !("capture" in original) ||
    !("current" in original) || typeof original.current !== "function" ||
    !("preloaded" in original) || typeof original.preloaded !== "function" ||
    !("prepareWorkRuntime" in original) || typeof original.prepareWorkRuntime !== "function" ||
    !("prepareSidecar" in original) || typeof original.prepareSidecar !== "function" ||
    !("bindSidecar" in original) || typeof original.bindSidecar !== "function" ||
    !("closeSidecar" in original) || typeof original.closeSidecar !== "function") throw failure("native-entry")
  return original as WindowsNativeSidecarPort
}
function failure(stage: string) {
  return Object.assign(new Error(`Windows native sidecar bootstrap unavailable (${stage})`), {
    code: "WINDOWS_FIRST_LOADER_UNAVAILABLE", stage,
  })
}
