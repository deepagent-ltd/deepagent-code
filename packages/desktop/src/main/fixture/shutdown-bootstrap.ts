import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { app, utilityProcess } from "electron"
import type { UtilityProcess } from "electron"
import { Effect, Fiber } from "effect"
import { bindDesktopShutdownSignals, createDesktopShutdown } from "../shutdown"

const root = process.env.DAC_SHUTDOWN_ROOT
const utility = process.env.DAC_SHUTDOWN_UTILITY
const scenario = process.env.DAC_SHUTDOWN_SCENARIO
if (!root || !utility || !scenario) throw new Error("shutdown bootstrap fixture requires isolated paths and a scenario")
app.setPath("userData", path.join(root, "user-data"))
app.setPath("sessionData", path.join(root, "session-data"))
app.on("window-all-closed", () => {})

const target: { current?: UtilityProcess } = {}
const facts = {
  scenario,
  beforeQuit: 0,
  prevented: 0,
  stops: 0,
  utilityStops: 0,
  acquisitions: 0,
  adopted: 0,
  continuedBootstrap: 0,
  publishedReady: 0,
  bootstrapJoined: false,
  childExit: false,
  childCode: -1,
  childExitedAt: 0,
  actionsWhileAcquiring: -1,
  actionsWhenStopping: -1,
  actionAt: 0,
  quitActions: 0,
  exitActions: 0,
  signals: 0,
  errors: [] as string[],
}
const migration = Promise.withResolvers<void>()
const adoption = Promise.withResolvers<void>()
const exit = Promise.withResolvers<void>()
const persist = () => writeFileSync(path.join(root, "main.json"), JSON.stringify(facts), { mode: 0o600 })
const deadline = setTimeout(() => {
  persist()
  target.current?.kill()
  app.exit(70)
}, 10_000)
const shutdown = createDesktopShutdown({
  cancelBootstrap: async () => {
    await Effect.runPromise(Fiber.interrupt(mainFiber))
    facts.bootstrapJoined = mainFiber.pollUnsafe() !== undefined
    migration.resolve()
  },
  stop: async () => {
    facts.stops++
    if (!target.current) return
    facts.utilityStops++
    target.current.postMessage({ type: "stop" })
    await exit.promise
  },
  quit: () => {
    facts.quitActions++
    facts.actionAt = Date.now()
    assert.equal(facts.bootstrapJoined, true)
    if (facts.acquisitions) assert.equal(facts.childExit, true)
    app.quit()
  },
  relaunch: () => { throw new Error("fixture does not request relaunch") },
  exit: () => {
    facts.exitActions++
    facts.actionAt = Date.now()
    assert.equal(facts.bootstrapJoined, true)
    assert.equal(facts.childExit, true)
    clearTimeout(deadline)
    persist()
    app.exit(0)
  },
  onError: (error) => { facts.errors.push(String(error)) },
})
app.on("before-quit", (event) => {
  facts.beforeQuit++
  shutdown.beforeQuit(event)
  if (event.defaultPrevented) facts.prevented++
})
app.on("will-quit", () => {
  clearTimeout(deadline)
  persist()
})
bindDesktopShutdownSignals(
  (ready) => { app.once("ready", ready) },
  () => { facts.signals++; void shutdown.signal() },
)

const mainFiber = Effect.runFork(Effect.gen(function* () {
  if (scenario === "early") {
    yield* Effect.promise(() => migration.promise)
    facts.continuedBootstrap++
  }
  yield* Effect.promise(() => app.whenReady())
  yield* Effect.promise(() => shutdown.start(async () => {
    facts.acquisitions++
    const ready = Promise.withResolvers<void>()
    const child = utilityProcess.fork(utility, [], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: root, DAC_SHUTDOWN_ROOT: root },
      stdio: "pipe",
    })
    child.once("exit", (code) => {
      facts.childExit = true
      facts.childCode = code
      facts.childExitedAt = Date.now()
      exit.resolve()
    })
    child.on("message", (message: unknown) => {
      if (typeof message !== "object" || message === null || !("type" in message)) return
      if (message.type === "ready") {
        ready.resolve()
        app.quit()
        app.quit()
        // The real child exists, but adoption is deliberately still in flight.
        // Both Quit calls must wait; the final action cannot run at this point.
        facts.actionsWhileAcquiring = facts.quitActions + facts.exitActions
        assert.equal(facts.actionsWhileAcquiring, 0)
        assert.equal(shutdown.closing, true)
        adoption.resolve()
        return
      }
      if (message.type !== "stopping") return
      facts.actionsWhenStopping = facts.quitActions + facts.exitActions
      assert.equal(facts.actionsWhenStopping, 0)
      if (scenario === "signal") {
        // Windows SIGTERM kills the process directly; qualify its registered handler explicitly.
        if (process.platform === "win32") { process.emit("SIGTERM"); process.emit("SIGTERM"); return }
        process.kill(process.pid, "SIGTERM")
        process.kill(process.pid, "SIGTERM")
      }
    })
    await ready.promise
    await adoption.promise
    target.current = child
    facts.adopted++
    return child
  }))
  if (shutdown.closing) return
  facts.publishedReady++
}))
if (scenario === "early") queueMicrotask(() => { app.quit(); app.quit() })
