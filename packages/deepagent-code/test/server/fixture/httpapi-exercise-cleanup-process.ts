// Dedicated process: bootstrap paths before importing any production service or global singleton.
await import("../httpapi-exercise/environment-bootstrap")
const { existsSync } = await import("node:fs")
const { stat } = await import("node:fs/promises")
const { Effect } = await import("effect")
const { Database } = await import("@deepagent-code/core/database/database")
const { builtAppRuntimeRoot } = await import("../../../src/effect/app-runtime")
const { TestLLMServer } = await import("../../lib/llm-server")
const { runScenario } = await import("../httpapi-exercise/runner")
const { parseOptions } = await import("../httpapi-exercise/routing")
const { deepagentScenarios } = await import("../httpapi-exercise/scenarios/deepagent")
const { exerciseDatabasePath } = await import("../httpapi-exercise/environment")
const { disposeApps } = await import("../httpapi-exercise/backend")
const options = parseOptions(["--mode", "effect", "--include", "deepagent.goal", "--trace"])
const selected = deepagentScenarios.filter(
  (scenario) => scenario.kind === "active" && scenario.name.startsWith("deepagent.goal"),
)
const results = await Effect.runPromise(
  Effect.gen(function* () {
    const results = yield* Effect.forEach(selected, runScenario(options), { concurrency: 1 })
    const first = selected[0]!
    if (first.kind !== "active") throw new Error("Missing active Goal scenario")
    const failed = yield* runScenario(options)({
      ...first,
      name: "cleanup.expected-failure",
      expect: () => Effect.die("expected assertion failure"),
    })
    if (failed.status !== "fail" || !failed.message.includes("expected assertion failure"))
      throw new Error("Assertion failure was masked")
    return results
  }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped),
)
await disposeApps()
if (results.length !== 7 || results.some((result) => result.status !== "pass")) throw new Error(JSON.stringify(results))
if (builtAppRuntimeRoot() !== undefined) throw new Error("Cleanup built the global AppRuntime")
if (existsSync(`${exerciseDatabasePath}.runtime.lock`)) throw new Error("Owned application lock was retained")
if (await Bun.file(exerciseDatabasePath).exists()) throw new Error("Reset fixture was not deleted")

// A genuine new writable owner must be able to reopen the exact path after all HTTP/app scopes close.
const reopened = await Effect.runPromise(
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db.run("CREATE TABLE cleanup_probe (value TEXT NOT NULL)")
    yield* db.run("INSERT INTO cleanup_probe VALUES ('retained')")
    const before = yield* Effect.promise(() => stat(exerciseDatabasePath))
    const scenario = selected[0]!
    const refused = yield* runScenario(options)(scenario)
    if (refused.status !== "fail" || !refused.message.includes("retained a live database owner"))
      throw new Error("Live owner cleanup did not fail closed")
    const after = yield* Effect.promise(() => stat(exerciseDatabasePath))
    if (before.dev !== after.dev || before.ino !== after.ino) throw new Error("Cleanup replaced a still-owned database")
    const rows = yield* db.all("SELECT value FROM cleanup_probe")
    if (JSON.stringify(rows) !== '[{"value":"retained"}]') throw new Error("Cleanup modified a still-owned database")
    return yield* db.all("PRAGMA quick_check")
  }).pipe(
    Effect.provide(Database.layerFromPath(exerciseDatabasePath)),
    Effect.provide(TestLLMServer.layer),
    Effect.scoped,
  ),
)
if (existsSync(`${exerciseDatabasePath}.runtime.lock`)) throw new Error("Reopened owner did not release")
if (builtAppRuntimeRoot() !== undefined) throw new Error("Failure cleanup built the global AppRuntime")
console.log(
  "HTTPAPI_CLEANUP_PROOF",
  JSON.stringify({
    selected: results.length,
    pass: results.length,
    globalRootBuilt: false,
    ownerReleased: true,
    failurePreserved: true,
    ownedDatabasePreservedOnRefusal: true,
    reopened,
  }),
)
