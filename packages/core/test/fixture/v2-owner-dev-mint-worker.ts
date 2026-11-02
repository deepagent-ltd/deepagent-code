import "./install-version"
import { Effect, Layer, Option, Schedule, Schema } from "effect"
import fs from "node:fs/promises"
import { hostname } from "node:os"
import { join } from "node:path"
import { Database } from "../../src/database/database"
import { DatabaseBootstrapError } from "../../src/database/bootstrap"
import { FSUtil } from "../../src/fs-util"
import { Global } from "../../src/global"
import { V2OwnerDevMint } from "../../src/session/runner/v2-owner-dev-mint"
import { EffectFlock } from "../../src/util/effect-flock"

const input = JSON.parse(process.argv[2]!) as { readonly database: string; readonly state: string }
process.env.DAC_TEST_OWNER_PREFLIGHT_ROOT = input.state
process.env.DEEPAGENT_CODE_V2_OWNER_DEV_MINT = "1"
delete process.env.DEEPAGENT_CODE_V2_OWNER_CAMPAIGN
delete process.env.DEEPAGENT_CODE_V2_OWNER_AUTHORIZATION_PUBLIC_KEY

const global = Global.layerWith({ state: input.state })
const flock = EffectFlock.layer.pipe(Layer.provide(global), Layer.provide(FSUtil.defaultLayer))

const outcome = await Effect.runPromise(
  Effect.gen(function* () {
    return yield* V2OwnerDevMint.ensureDevOwnerAuthorization((yield* Database.Service).db, input.state)
  }).pipe(
    Effect.provide(Database.layerFromPath(input.database)),
    Effect.provide(flock),
    // Database preflight deliberately fences a concurrent process during migration checks.
    // Retry only that transient refusal; all other bootstrap failures still fail the worker.
    Effect.retry({
      while: (error) => error instanceof DatabaseBootstrapError &&
        error.state.issues.some((issue) => issue.code === "another_process_active"),
      schedule: Schedule.spaced("50 millis").pipe(Schedule.take(20)),
    }),
    Effect.tapError((error) => error instanceof DatabaseBootstrapError
      ? Effect.tryPromise({
          try: async () => {
            console.error(JSON.stringify({
              fixture: "owner-dev-mint-worker", stage: "final-bootstrap-error",
              phase: error.state.phase, mode: error.state.mode,
              issues: error.state.issues.map((issue) => ({ code: issue.code, message: issue.message })),
              originalObservations: { available: false, exists: null, sqliteHeaderValid: null, dbReadable: null,
                journalMode: null, activeProcess: null, dbInspectionDeferred: null },
              postFailurePhysical: await postFailurePhysical(),
            }))
          },
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.sync(() => console.error(JSON.stringify({
          fixture: "owner-dev-mint-worker", stage: "final-bootstrap-error", phase: error.state.phase,
          issues: error.state.issues.map((issue) => ({ code: issue.code, message: issue.message })),
          physicalSnapshotUnavailable: true,
        })))))
      : Effect.void),
  ),
)

process.stdout.write(JSON.stringify(outcome))

// The BootstrapState does not retain its original observations. These are later physical
// facts only: no SQLite opener, process lock acquisition, keypair or business SQL read.
async function postFailurePhysical() {
  const entry = await fs.lstat(input.database).then(
    (stat) => ({ exists: true, size: stat.size, symlink: stat.isSymbolicLink(), links: stat.nlink }),
    (error: unknown) => ({ exists: absent(error) }),
  )
  const header = await fs.open(input.database, "r").then(async (file) => {
    try {
      const bytes = Buffer.alloc(20)
      const read = await file.read(bytes, 0, bytes.length, 0)
      return { sqliteHeaderValid: read.bytesRead >= 16 && bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")),
        journalMode: read.bytesRead < 20 ? null : bytes[18] === 2 && bytes[19] === 2 ? "wal"
          : bytes[18] === 1 && bytes[19] === 1 ? "delete" : null }
    } finally { await file.close() }
  }, () => ({ sqliteHeaderValid: null, journalMode: null }))
  const companions = await Promise.all(["-wal", "-shm"].map((suffix) =>
    fs.lstat(input.database + suffix).then(() => true, (error: unknown) => absent(error))))
  const owner = await fs.readFile(join(input.database + ".runtime.lock", "meta.json"), "utf8").then(
    Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
      pid: Schema.Int.check(Schema.isGreaterThan(0)), hostname: Schema.String,
    }))), () => Option.none(),
  )
  const alive = () => {
    if (Option.isNone(owner) || owner.value.hostname !== hostname()) return null
    try { process.kill(owner.value.pid, 0); return true }
    catch (error) { return error && typeof error === "object" && "code" in error && error.code === "ESRCH" ? false : null }
  }
  return { ...entry, ...header, walExists: companions[0], shmExists: companions[1],
    runtimeOwnerPID: Option.isSome(owner) ? owner.value.pid : null, runtimeOwnerProcessAlive: alive() }
}

function absent(error: unknown) {
  return error && typeof error === "object" && "code" in error && error.code === "ENOENT" ? false : null
}
