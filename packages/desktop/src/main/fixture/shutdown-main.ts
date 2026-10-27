import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { app, utilityProcess } from "electron"
import type { UtilityProcess } from "electron"
import { createDesktopShutdown } from "../shutdown"

const root = process.env.DAC_SHUTDOWN_ROOT
const utility = process.env.DAC_SHUTDOWN_UTILITY
const scenario = process.env.DAC_SHUTDOWN_SCENARIO
if (!root || !utility || !scenario) throw new Error("shutdown fixture requires isolated paths and a scenario")
app.setPath("userData", path.join(root, "user-data"))
app.setPath("sessionData", path.join(root, "session-data"))
app.on("window-all-closed", () => {})

async function main() {
  await app.whenReady()
  const target: { current?: UtilityProcess } = {}
  const facts = {
    scenario,
    stops: 0,
    emptyStops: 0,
    utilityStops: 0,
    beforeQuit: 0,
    prevented: 0,
    quitActions: 0,
    exitActions: 0,
    relaunchActions: 0,
    signals: 0,
    willQuit: 0,
    childExit: false,
    childCode: -1,
    childExitedAt: 0,
    actionAt: 0,
    actionsWhenStopping: -1,
    joined: false,
    errors: [] as string[],
  }
  const exit = Promise.withResolvers<void>()
  const persist = () => writeFileSync(path.join(root, "main.json"), JSON.stringify(facts), { mode: 0o600 })
  const deadline = setTimeout(() => {
    persist()
    target.current?.kill()
    app.exit(70)
  }, 10_000)
  const shutdown = createDesktopShutdown({
    stop: () => {
      facts.stops++
      if (!target.current) {
        facts.emptyStops++
        return Promise.resolve()
      }
      facts.utilityStops++
      target.current.postMessage({ type: "stop" })
      return exit.promise
    },
    quit: () => {
      facts.quitActions++
      facts.actionAt = Date.now()
      assert.equal(facts.childExit, true)
      app.quit()
    },
    // Count the restart action without spawning another application.
    relaunch: () => {
      facts.relaunchActions++
    },
    exit: () => {
      facts.exitActions++
      facts.actionAt = Date.now()
      assert.equal(facts.childExit, true)
      clearTimeout(deadline)
      persist()
      app.exit(0)
    },
    onError: (error) => {
      facts.errors.push(String(error))
    },
  })
  if (scenario === "routine") {
    await shutdown.stop()
    assert.equal(facts.emptyStops, 1)
  }
  const child = utilityProcess.fork(utility, [], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: root,
      DAC_SHUTDOWN_ROOT: root,
    },
    stdio: "pipe",
  })
  app.on("before-quit", (event) => {
    facts.beforeQuit++
    shutdown.beforeQuit(event)
    if (event.defaultPrevented) facts.prevented++
  })
  app.on("will-quit", () => {
    facts.willQuit++
    assert.equal(facts.childExit, true)
    void shutdown.stop()
    clearTimeout(deadline)
    persist()
  })
  process.on("SIGTERM", () => {
    facts.signals++
    void shutdown.signal()
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
      target.current = child
      const first = shutdown.stop()
      facts.joined = first === shutdown.stop()
      app.quit()
      app.quit()
      return
    }
    if (message.type !== "stopping") return
    facts.actionsWhenStopping = facts.quitActions + facts.exitActions + facts.relaunchActions
    assert.equal(facts.actionsWhenStopping, 0)
    assert.equal(facts.utilityStops, 1)
    if (scenario === "signal") {
      // Windows SIGTERM kills the process directly; qualify its registered handler explicitly.
      if (process.platform === "win32") { process.emit("SIGTERM"); process.emit("SIGTERM"); return }
      process.kill(process.pid, "SIGTERM")
      process.kill(process.pid, "SIGTERM")
      return
    }
    if (scenario === "relaunch") {
      assert.equal(shutdown.relaunch(), shutdown.relaunch())
      app.quit()
    }
  })
}

void main().catch((error: unknown) => {
  writeFileSync(path.join(root, "failure.json"), JSON.stringify({ error: String(error) }), { mode: 0o600 })
  app.exit(1)
})
