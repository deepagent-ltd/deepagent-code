import { expect, test } from "bun:test"
import { Effect, Exit, Option, Schema } from "effect"
import { Database } from "../src/database/database"
import { sql } from "drizzle-orm"
import { EventValidation } from "../src/deepagent/event-validation"
import { EventValidationSchema } from "../src/deepagent/event-validation.schema"
import { WorkCommandV2Schema } from "../src/session/work-command-v2.schema"
import { EventValidationStoreFixture } from "./fixture/event-validation-store"

const linux = {
  ...EventValidationStoreFixture.configuration().recipe,
  schemaVersion: "work-command-recipe.v2",
  executable: { assetPath: "packages/work-file-helper/bin/linux-x64/bun-command-runtime", sha256: "c".repeat(64),
    bytes: 10, platform: "linux-x64", identity: { kind: "posix", device: "1", inode: "4" } },
  sandbox: { id: "linux-cgroup2-single-payload-v1", revision: 1, network: "deny", filesystem: "explicit_snapshot_closure",
    payloadProcesses: 1, payloadThreadsMax: 64, supervisorProcessesMax: 2, openFiles: 64,
    stopProof: "root_exit_stream_eof_tree_empty", threadsEnforcement: "cgroup_pids", tasksMax: 66,
    cpu: { quotaMicros: 100000, periodMicros: 100000, totalWatchdogMicros: 60000000, pollMs: 20 },
    memory: { maxBytes: 268435456, swapMaxBytes: 0 } },
}

test("EV accepts an explicitly approved Linux v2 recipe without changing the original Mac configuration", () => {
  const mac = { ...EventValidationStoreFixture.configuration(), expiresAt: 2000000000000 }
  expect(JSON.stringify(Schema.decodeUnknownSync(EventValidationSchema.Configuration)(mac))).toBe(JSON.stringify(mac))
  expect(EventValidation.hash(mac)).toBe("969a2e3dedd1b6111ad0bb2799491993a1beefbe7c8ea28053ae57fd43ad5a22")
  expect(Option.isSome(WorkCommandV2Schema.decodeRecipe(linux))).toBe(true)
  const current = { ...mac, recipe: linux }
  expect(Option.isSome(Schema.decodeUnknownOption(EventValidationSchema.Configuration)(current))).toBe(true)
})

test("EV Linux requests cannot supply a native handle, cross-platform recipe or other profile", () => {
  const configuration = EventValidationStoreFixture.configuration()
  const decode = Schema.decodeUnknownOption(EventValidationSchema.Configuration, { onExcessProperty: "error" })
  for (const recipe of [
    { ...linux, executable: { ...linux.executable, platform: "darwin-arm64" } },
    { ...linux, sandbox: { ...linux.sandbox, delegatedCgroup: "/caller/cgroup" } },
    { ...linux, executable: "installed-bun-v2" },
    { ...linux, inputs: ["../outside"] },
  ]) expect(Option.isNone(decode({ ...configuration, recipe }))).toBe(true)
  expect(Option.isNone(decode({ ...configuration, recipe: linux, profile: "event_investigate_v1" }))).toBe(true)
  const request = { ...linux, executable: "installed-bun-v2", target: "linux-x64" }
  expect(Option.isSome(Schema.decodeUnknownOption(EventValidationSchema.RecipeRequest, { onExcessProperty: "error" })(request))).toBe(true)
  expect(Option.isNone(Schema.decodeUnknownOption(EventValidationSchema.RecipeRequest, { onExcessProperty: "error" })({ ...request, target: "win32-x64" }))).toBe(true)
})

test("generated EV recipe and request contracts advertise Linux POSIX isolation only", () => {
  for (const schema of [EventValidationSchema.LinuxRecipe, EventValidationSchema.LinuxRecipeRequest,
    EventValidationSchema.Recipe, EventValidationSchema.RecipeRequest]) {
    const encoded = JSON.stringify(Schema.toJsonSchemaDocument(schema))
    expect(encoded).toContain("linux-x64")
    expect(encoded).toContain("linux-arm64")
    expect(encoded).toContain("linux-cgroup2-single-payload-v1")
    for (const forbidden of ["win32-x64", "win32-arm64", "windows", "volumeSerial", "fileID", "win32-job-appcontainer"]) {
      expect(encoded).not.toContain(forbidden)
    }
  }
})

function dispatched(db: Database.Interface["db"], configuration: EventValidationSchema.Configuration,
  native: EventValidation.Native["Service"]) {
  return Effect.gen(function* () {
    yield* EventValidation.configure(db, { ruleID: "rule", requestID: "create", expectedRevision: 0, configuration })
    yield* EventValidation.control(db, { ruleID: "rule", requestID: "enable", expectedRevision: 1, action: "enable" })
    const observed = yield* EventValidation.observe(db, "rule", true)
    const claimed = yield* EventValidation.claim(db, "rule", observed.observation, "owner")
    if (!claimed) throw new Error("Missing private run")
    yield* EventValidation.preparing(db, claimed.run.runID, "owner")
    const handle = yield* native.prepare(configuration, observed.observation, claimed.run.workspaceBasename, claimed.run.deadline)
    yield* EventValidation.prepared(db, claimed.run.runID, "owner", handle)
    yield* EventValidation.dispatch(db, claimed.run.runID, "owner", handle)
    return claimed.run.runID
  })
}

test("Linux Ready commits current authority and original observed PID once in the existing transaction", () => EventValidationStoreFixture.fixture(async (f) => {
  await f.run(EventValidationStoreFixture.authorized(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const id = yield* dispatched(db, f.configuration, f.native.service)
    const before = (yield* EventValidation.getRun(db, id))!
    const started = yield* EventValidation.started(db, id, "owner", 1234, "before_continue")
    expect(started).toEqual({ ...before, processID: 1234, revision: before.revision + 1 })
    expect(Exit.isFailure(yield* Effect.exit(EventValidation.started(db, id, "owner", 5678, "before_continue")))).toBe(true)
    expect(yield* EventValidation.getRun(db, id)).toEqual(started)
    expect(yield* db.get("SELECT count(*) count FROM session_input")).toEqual({ count: 0 })
    expect(yield* db.get("SELECT count(*) count FROM session_v2_provider_turn_receipt")).toEqual({ count: 0 })
  }).pipe(Effect.provideService(EventValidation.Native, f.native.service), Effect.scoped)))
  expect(f.native.state.executed).toBe(0)
}))

test("late pause refuses Linux Continue while Mac can still record the actual late PID; cold read retains custody", () => EventValidationStoreFixture.fixture(async (f) => {
  const saved = await f.run(EventValidationStoreFixture.authorized(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const id = yield* dispatched(db, f.configuration, f.native.service)
    yield* EventValidation.control(db, { ruleID: "rule", requestID: "pause", expectedRevision: 2, action: "pause" })
    const before = (yield* EventValidation.getRun(db, id))!
    expect(Exit.isFailure(yield* Effect.exit(EventValidation.started(db, id, "owner", 1234, "before_continue")))).toBe(true)
    expect(yield* EventValidation.getRun(db, id)).toEqual(before)
    const observed = yield* EventValidation.started(db, id, "owner", 1234)
    expect(observed.processID).toBe(1234)
    expect(observed.state).toBe("dispatching")
    expect(observed.releasedAt).toBeNull()
    expect(yield* EventValidation.canSchedule(db, before.projectKey)).toBe(false)
    return observed
  }).pipe(Effect.provideService(EventValidation.Native, f.native.service), Effect.scoped)))
  await f.run(EventValidationStoreFixture.authorized(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    expect(yield* EventValidation.getRun(db, saved.runID)).toEqual(saved)
    expect((yield* EventValidation.history(db, "rule"))[0]).toEqual(saved)
    expect(yield* EventValidation.canSchedule(db, saved.projectKey)).toBe(false)
    expect(yield* db.get("SELECT count(*) count FROM session_input")).toEqual({ count: 0 })
  })))
  expect(f.native.state.executed).toBe(0)
}))

for (const cause of ["source", "late-sql"] as const) test(`Linux Ready ${cause} failure keeps the full original run and reservation`, () => EventValidationStoreFixture.fixture(async (f) => {
  await f.run(EventValidationStoreFixture.authorized(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const id = yield* dispatched(db, f.configuration, f.native.service)
    if (cause === "source") yield* db.run(sql`UPDATE context_security_namespace SET retired_at=${Date.now()}`)
    if (cause === "late-sql") yield* db.run("CREATE TRIGGER ev_owned_pid_fault BEFORE UPDATE ON event_validation_run WHEN json_extract(NEW.record,'$.processID') IS NOT NULL BEGIN SELECT RAISE(ABORT,'owned Ready rollback'); END")
    const before = (yield* EventValidation.getRun(db, id))!
    expect(Exit.isFailure(yield* Effect.exit(EventValidation.started(db, id, "owner", 1234, "before_continue")))).toBe(true)
    expect(yield* EventValidation.getRun(db, id)).toEqual(before)
    expect(before.state).toBe("dispatching")
    expect(before.processID).toBeNull()
    expect(before.releasedAt).toBeNull()
    expect(before.retainedBytes).toBeGreaterThan(0)
    expect(yield* EventValidation.canSchedule(db, before.projectKey)).toBe(false)
  }).pipe(Effect.provideService(EventValidation.Native, f.native.service), Effect.scoped)))
  expect(f.native.state.executed).toBe(0)
}))
