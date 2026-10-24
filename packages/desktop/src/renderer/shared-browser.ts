import type {
  SharedBrowserPlatform,
  SharedBrowserRootBridge,
  SharedBrowserRootResponse,
  SharedBrowserView,
} from "@deepagent-code/core/browser/shared-platform"
import type { SharedBrowserTuiSchema } from "@deepagent-code/core/browser/shared-tui-schema"

/** One connection for the app root lifetime. Component unsubscriptions only stop
 * local observations; they never destroy Main's page or its Agent lease. */
export function createSharedBrowserPlatform(bridge: SharedBrowserRootBridge) {
  const generation = bridge.register().generation
  const callbacks = new Set<(state: SharedBrowserView) => void>()
  const tuiCallbacks = new Set<(state: SharedBrowserTuiSchema.View) => void>()
  let disposed = false
  const unsubscribe = bridge.onState((response) => {
    if (disposed || response.generation !== generation) return
    for (const callback of callbacks) callback(response.value)
  })
  const unsubscribeTui = bridge.onTuiState((response) => {
    if (disposed || response.generation !== generation) return
    for (const callback of tuiCallbacks) callback(response.value)
  })
  const result = async <Value>(operation: Promise<SharedBrowserRootResponse<Value>>) => {
    const response = await operation
    if (disposed || response.generation !== generation)
      throw new Error("The original shared browser UI connection was retired")
    return response.value
  }
  const current = () => {
    if (disposed) throw new Error("The original shared browser UI connection was retired")
    return generation
  }
  const platform: SharedBrowserPlatform = {
    list: async (sessionID) => result(bridge.list(current(), sessionID)),
    create: async (input) => result(bridge.create(current(), input)),
    takeover: async (input) => result(bridge.takeover(current(), input)),
    close: async (input) => result(bridge.close(current(), input)),
    ...(bridge.approveOrigin ? { approveOrigin: async (input: Parameters<NonNullable<SharedBrowserPlatform["approveOrigin"]>>[0]) =>
      result(bridge.approveOrigin!(current(), input)) } : {}),
    ...(bridge.cancelOrigin ? { cancelOrigin: async (input: Parameters<NonNullable<SharedBrowserPlatform["cancelOrigin"]>>[0]) =>
      result(bridge.cancelOrigin!(current(), input)) } : {}),
    preview: async (input) => result(bridge.preview(current(), input)),
    stampInput: async (input) => result(bridge.stampInput(current(), input)),
    sealInput: async (input) => result(bridge.sealInput(current(), input)),
    tuiPending: async (rootSessionID) => result(bridge.tuiPending(current(), rootSessionID)),
    tuiApprove: async (input) => result(bridge.tuiApprove(current(), input)),
    tuiDetach: async (input) => result(bridge.tuiDetach(current(), input)),
    onTuiState: (callback) => {
      current()
      if (tuiCallbacks.size >= 32 && !tuiCallbacks.has(callback)) throw new Error("TUI pairing observer limit reached")
      tuiCallbacks.add(callback)
      return () => {
        tuiCallbacks.delete(callback)
      }
    },
    onState: (callback) => {
      current()
      if (callbacks.size >= 64 && !callbacks.has(callback)) throw new Error("Shared browser UI observer limit reached")
      callbacks.add(callback)
      return () => {
        callbacks.delete(callback)
      }
    },
  }
  return {
    platform,
    dispose: () => {
      if (disposed) return
      disposed = true
      callbacks.clear()
      tuiCallbacks.clear()
      unsubscribe()
      unsubscribeTui()
      // An old HMR dispose can arrive after a new root registered. Main compares
      // this exact generation and leaves the replacement connection untouched.
      void bridge.detach(generation).catch(() => undefined)
    },
  }
}
