type StopObservation =
  | { kind: "normal" | "forced"; exitCode: number }
  | { kind: "unconfirmed"; killRequested: boolean; killAccepted: boolean | undefined }
  | { kind: "late_exit"; exitCode: number; forced: boolean }

export function createSidecarStop(options: {
  postStop: () => void
  kill: () => boolean
  exit: Promise<number>
  hasExited: () => boolean
  onObservation?: (observation: StopObservation) => void
  gracefulMs?: number
  forcedJoinMs?: number
}) {
  const state: {
    pending?: Promise<void>
    settled: boolean
    killRequested: boolean
    killAccepted?: boolean
    cause?: unknown
    graceful?: ReturnType<typeof setTimeout>
    forced?: ReturnType<typeof setTimeout>
  } = { settled: false, killRequested: false }
  const observe = (observation: StopObservation) => {
    // A logging callback cannot turn a real exit into a failed stop or prevent
    // the original caller from receiving its result.
    void Promise.resolve().then(() => options.onObservation?.(observation)).catch(() => undefined)
  }
  const clear = () => {
    clearTimeout(state.graceful)
    clearTimeout(state.forced)
  }
  return () => {
    if (state.pending) return state.pending
    const result = Promise.withResolvers<void>()
    state.pending = result.promise
    const unconfirmed = (cause?: unknown) => {
      if (state.settled) return
      state.settled = true
      clear()
      const observation: StopObservation = {
        kind: "unconfirmed",
        killRequested: state.killRequested,
        killAccepted: state.killAccepted,
      }
      observe(observation)
      result.reject(Object.assign(new Error("Sidecar stop could not confirm the original utility process exit", {
        cause: cause ?? state.cause,
      }), { code: "SIDECAR_STOP_UNCONFIRMED", ...observation }))
    }
    options.exit.then((exitCode) => {
      if (state.settled) {
        observe({ kind: "late_exit", exitCode, forced: state.killRequested })
        return
      }
      state.settled = true
      clear()
      observe({ kind: state.killRequested ? "forced" : "normal", exitCode })
      result.resolve()
    }, unconfirmed)
    state.graceful = setTimeout(() => {
      if (state.settled) return
      // A successful kill() only acknowledges the request. The original exit
      // event must still arrive within this separate, bounded join window.
      state.forced = setTimeout(unconfirmed, options.forcedJoinMs ?? 2_000)
      if (options.hasExited()) return
      state.killRequested = true
      try {
        state.killAccepted = options.kill()
      } catch (error) {
        state.cause = error
      }
    }, options.gracefulMs ?? 6_000)
    if (!options.hasExited()) {
      try {
        options.postStop()
      } catch (error) {
        // The dispatch may have partially happened. Keep custody and wait for the
        // original exit rather than retrying or assuming there were no effects.
        state.cause = error
      }
    }
    return result.promise
  }
}
