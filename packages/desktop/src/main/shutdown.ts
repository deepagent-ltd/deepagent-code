type Intent = "quit" | "relaunch" | "exit"

export function bindDesktopShutdownSignals(onReady: (ready: () => void) => void, terminate: () => void) {
  const signals = ["SIGINT", "SIGTERM"] as const
  signals.forEach((signal) => process.on(signal, terminate))
  onReady(() => {
    // Electron installs its POSIX sigaction handlers after loading user Main
    // code. Renew only our subscriptions once that initialization has finished.
    signals.forEach((signal) => {
      process.off(signal, terminate)
      process.on(signal, terminate)
    })
  })
}

export function createDesktopShutdown(options: {
  stop: () => Promise<void>
  cancelBootstrap?: () => Promise<void>
  quit: () => void
  relaunch: () => void
  exit: () => void
  onError: (error: unknown) => void
}) {
  const state: {
    startup?: Promise<unknown>
    stop?: Promise<void>
    completion?: Promise<void>
    intent?: Intent
    completed: boolean
  } = { completed: false }

  const stop = () => {
    if (state.stop) return state.stop
    const pending = Promise.resolve().then(async () => {
      // The startup callback owns adoption of its listener even if the caller
      // stops awaiting it. Do not mistake an in-flight acquisition for no server.
      await state.startup?.then(() => undefined, () => undefined)
      await options.stop()
    })
    state.stop = pending
    const release = () => {
      // IPC and updater stops can precede adoption of another sidecar. Only a
      // terminal request owns this promise beyond its settlement.
      if (state.completion === undefined && state.stop === pending) state.stop = undefined
    }
    void pending.then(release, release)
    return pending
  }
  const request = (intent: Intent) => {
    // An OS shutdown supersedes a pending restart; every caller still joins the
    // original stop. Once an action has been dispatched it cannot run again.
    if (
      !state.completed &&
      (state.intent === undefined || intent === "exit" || (intent === "relaunch" && state.intent === "quit"))
    )
      state.intent = intent
    state.completion ??= Promise.resolve()
      // A prior routine stop may already be settled or in flight. Cancellation
      // belongs to the terminal request, not to that reusable resource stop.
      .then(options.cancelBootstrap)
      .then(() => undefined, options.onError)
      .then(stop)
      .then(() => undefined, options.onError)
      .then(() => {
        state.completed = true
        if (state.intent === "quit") {
          options.quit()
          return
        }
        if (state.intent === "relaunch") options.relaunch()
        options.exit()
      })
    return state.completion
  }

  return {
    get closing() {
      return state.intent !== undefined
    },
    start: <A>(operation: () => Promise<A>): Promise<A> => {
      if (state.intent !== undefined || state.stop !== undefined || state.startup !== undefined)
        return Promise.reject(Object.assign(new Error("Desktop sidecar startup is unavailable during shutdown or another startup"), {
          code: "DESKTOP_STARTUP_CLOSED",
        }))
      const pending = Promise.resolve().then(() => {
        if (state.intent !== undefined || state.stop !== undefined)
          throw Object.assign(new Error("Desktop sidecar startup was closed before acquisition"), {
            code: "DESKTOP_STARTUP_CLOSED",
          })
        return operation()
      })
      state.startup = pending
      const release = () => {
        if (state.startup === pending) state.startup = undefined
      }
      void pending.then(release, release)
      return pending
    },
    stop,
    beforeQuit: (event: { preventDefault: () => void }) => {
      if (state.completed) return
      event.preventDefault()
      void request("quit")
    },
    signal: () => request("exit"),
    relaunch: () => request("relaunch"),
  }
}
