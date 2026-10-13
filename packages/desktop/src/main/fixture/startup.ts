import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { app } from "electron"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { migrateLegacyHome } from "@deepagent-code/core/global-migrate"
import { initializeDesktopStartup, prepareDesktopStorage } from "../startup"

const root = process.env.DAC_STARTUP_ROOT
const scenario = process.env.DAC_STARTUP_SCENARIO
if (!root || !scenario) throw new Error("startup fixture requires isolated paths")
const startup = initializeDesktopStartup(app)
const data = startup.dataRoot
const legacy = join(root, "legacy")
mkdirSync(join(legacy, "desktop"), { recursive: true })
writeFileSync(join(legacy, "desktop", "previous.txt"), "previous desktop storage")
writeFileSync(join(legacy, "config.json"), "previous config")
if (scenario === "occupied") {
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, "user.txt"), "current data")
}
const storage = startup.storage
const facts = { ready: false, migrationComplete: false, readyBeforeMigration: false, protectedData: false, merge: false, repeatedPaths: false, lateRefused: false }
app.once("ready", () => {
  facts.ready = true
  facts.readyBeforeMigration = !facts.migrationComplete
})
const deadline = setTimeout(() => app.exit(70), 5000)
const pathsReady = Deferred.makeUnsafe<void, unknown>()
const fiber = Effect.runFork(Effect.gen(function* () {
  yield* Effect.sleep(200)
  assert.equal(app.isReady(), false)
  assert.equal(existsSync(join(storage.session, "Local State")), false)
  assert.equal(existsSync(join(storage.session, "Preferences")), false)
  if (scenario === "failure") return yield* Effect.fail(new Error("original migration failure"))
  const result = yield* Effect.promise(() => migrateLegacyHome({ legacy, data, config: join(root, "config") }))
  const again = prepareDesktopStorage({ app, dataRoot: data, appID: "ai.deepagent-code.desktop.dev", name: "DeepAgent Code Dev" })
  facts.repeatedPaths = again.session === storage.session && app.getPath("sessionData") === storage.session && app.getPath("userData") === storage.root
  facts.migrationComplete = true
  facts.merge = result.migrated && readFileSync(join(data, "desktop", "previous.txt"), "utf8") === "previous desktop storage" && readFileSync(join(root, "config", "config.json"), "utf8") === "previous config"
  facts.protectedData = result.skipped === "data-home-exists" && readFileSync(join(data, "user.txt"), "utf8") === "current data"
  yield* Deferred.succeed(pathsReady, undefined)
  yield* Effect.promise(() => app.whenReady())
  assert.equal(facts.readyBeforeMigration, false)
  assert.equal(facts.repeatedPaths, true)
  assert.equal(scenario === "occupied" ? facts.protectedData : facts.merge, true)
  assert.throws(() => prepareDesktopStorage({ app, dataRoot: data, appID: "ai.deepagent-code.desktop.dev", name: "DeepAgent Code Dev" }), /before Electron is ready/)
  facts.lateRefused = true
  clearTimeout(deadline)
  writeFileSync(join(root, "safe.json"), JSON.stringify(facts), { mode: 0o600 })
  app.exit(0)
}).pipe(Effect.onExit((exit) => Exit.isFailure(exit) ? Deferred.failCause(pathsReady, exit.cause) : Effect.void)))
if (scenario === "interrupt") setTimeout(() => { void Effect.runPromise(Fiber.interrupt(fiber)) }, 50)
const completion = await Effect.runPromiseExit(Deferred.await(pathsReady))
if (["failure", "interrupt"].includes(scenario)) {
  assert.equal(Exit.isFailure(completion), true)
  assert.equal(app.isReady(), false)
  assert.equal(fiber.pollUnsafe() !== undefined, true)
  clearTimeout(deadline)
  writeFileSync(join(root, "terminal.json"), JSON.stringify({ gateTerminated: true, ready: app.isReady(), fiberSettled: true, scenario }), { mode: 0o600 })
  app.exit(0)
}
assert(fiber)
