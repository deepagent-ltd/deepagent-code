import { mkdir } from "node:fs/promises"
import path from "node:path"
import { count, eq } from "drizzle-orm"
import { Effect, Layer, LayerMap, Schema } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { Location } from "@deepagent-code/core/location"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecutionLocal } from "@deepagent-code/core/session/execution/local"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionRunner } from "@deepagent-code/core/session/runner"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionInputTable, TaskNotificationOutboxTable, TaskRunTable } from "@deepagent-code/core/session/sql"
import { SessionStore } from "@deepagent-code/core/session/store"
import { TaskRunAuthority } from "@deepagent-code/core/session/task-run"
import { TaskRunDispatcher } from "@deepagent-code/core/session/task-run-dispatcher"
import { TaskWorkspace } from "@deepagent-code/core/session/task-workspace"
import { V2TaskRunReceiptTable } from "@deepagent-code/core/session/runner/v2-task-run-receipt.sql"
import { TaskTool } from "@deepagent-code/core/tool/task"
import { Hash } from "@deepagent-code/core/util/hash"
import { projectLayer } from "./project-layer"

// The original Local executor must refuse the persisted claim before acquiring any Location
// runner. This trap supplies no model or transport; reaching it fails the negative oracle.
let locationAcquisitions = 0
const locations = Layer.effect(
  LocationServiceMap,
  LayerMap.make((_ref: Location.Ref) => {
    locationAcquisitions++
    return Layer.effect(SessionRunner.Service, Effect.die("An unresolved execution claim must not acquire a runner"))
  }).pipe(
    // This negative fixture has no Location services: every acquisition dies before execution.
    Effect.map((service) => service as unknown as LocationServiceMap["Service"]),
  ),
)
const database = Database.layerFromPath(process.argv[2]!)
const events = EventV2.layer.pipe(Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const execution = SessionExecutionLocal.layer.pipe(
  Layer.provide(events),
  Layer.provide(store),
  Layer.provide(locations),
  Layer.provide(TaskTool.delegationSlotLayer),
)
const sessions = SessionV2.layer.pipe(
  Layer.provide(database),
  Layer.provide(events),
  Layer.provide(store),
  Layer.provide(projectLayer(database)),
  Layer.provide(execution),
)
const stack = Layer.mergeAll(
  database,
  events,
  store,
  sessions,
  SessionProjector.layer.pipe(Layer.provide(database), Layer.provide(events)),
  TaskRunDispatcher.layer().pipe(Layer.provide(database), Layer.provide(sessions)),
)
const phase = process.argv[3]!
const root = process.argv[4]!
const parentID = SessionSchema.ID.make(process.argv[5]!)
const factsPath = path.join(root, "facts.json")
const repository = path.join(root, "repository")
const Facts = Schema.Struct({
  runID: Schema.String,
  childID: Schema.String,
  claim: Schema.Number,
  inputHash: Schema.String,
  directory: Schema.String,
})

const git = (args: string[]) => {
  const result = Bun.spawnSync(["git", "-C", repository, ...args], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString()
}

await Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const sessions = yield* SessionV2.Service
  const store = yield* SessionStore.Service
  const dispatcher = yield* TaskRunDispatcher.Service
  if (phase === "quarantine") {
    yield* Effect.promise(async () => {
      await mkdir(repository, { recursive: true })
      git(["init", "-b", "dev"])
      git(["config", "core.autocrlf", "false"])
      git(["config", "user.name", "Task recovery fixture"])
      git(["config", "user.email", "fixture@deepagent.local"])
      await Bun.write(path.join(repository, "original.txt"), "original fixture\n")
      git(["add", "original.txt"])
      git(["commit", "-m", "test: initialize private recovery fixture"])
    })
    const parent = yield* sessions.create({ id: parentID, location: { directory: AbsolutePath.make(repository) } })
    const submitted = yield* TaskRunAuthority.submit(db, yield* EventV2.Service, sessions, {
      parentSessionID: parent.id,
      parentMessageID: SessionMessage.ID.make("msg_unconfirmed_parent"),
      toolCallID: "call-unconfirmed-worktree",
      deliveryMode: "background",
      prompt: new Prompt({ text: "Preserve unknown child evidence." }),
      agent: "general",
      child: { title: "Unknown child", location: parent.location, permissions: [], workspace: { mode: "worktree" } },
    })
    const row = yield* db
      .select()
      .from(TaskRunTable)
      .where(eq(TaskRunTable.run_id, submitted.run.runID))
      .get()
      .pipe(Effect.orDie)
    if (!row?.worktree_directory) return yield* Effect.die("No original worktree")
    yield* Effect.promise(() =>
      Bun.write(path.join(row.worktree_directory!, "unconfirmed.txt"), "Unconfirmed child evidence\n"),
    )
    const inputs = yield* db
      .select()
      .from(SessionInputTable)
      .where(eq(SessionInputTable.session_id, submitted.run.childSessionID))
      .all()
      .pipe(Effect.orDie)
    const claim = yield* store.claim(submitted.run.childSessionID)
    if (claim === undefined) return yield* Effect.die("No original execution claim")
    yield* TaskRunAuthority.claim(db, {
      runID: submitted.run.runID,
      ownerToken: "dead-task-owner",
      leaseMs: 1000,
      now: Date.now() - 120000,
    })
    if ((yield* dispatcher.tick) !== 1) return yield* Effect.die("Expected one original dispatcher attempt")
    yield* dispatcher.awaitIdle
    yield* Effect.promise(() =>
      Bun.write(
        factsPath,
        JSON.stringify({
          runID: submitted.run.runID,
          childID: submitted.run.childSessionID,
          claim,
          inputHash: Hash.sha256(JSON.stringify(inputs)),
          directory: row.worktree_directory,
        }),
      ),
    )
  }
  const facts = Schema.decodeUnknownSync(Facts)(yield* Effect.promise(() => Bun.file(factsPath).json()))
  const row = yield* db.select().from(TaskRunTable).where(eq(TaskRunTable.run_id, facts.runID)).get().pipe(Effect.orDie)
  if (
    !row ||
    row.state !== "recovery_required" ||
    row.control_state !== "open" ||
    row.time_settled !== null ||
    row.execution_owner !== null ||
    row.lease_expires_at !== null ||
    row.worktree_state !== "ready" ||
    row.workspace_preflight_state !== "ready" ||
    row.workspace_branch_state !== "ready"
  )
    return yield* Effect.die("Unknown child custody was incorrectly settled or released")
  if ((yield* store.claimToken(SessionSchema.ID.make(facts.childID))) !== facts.claim)
    return yield* Effect.die("Original child execution claim changed")
  const inputs = yield* db
    .select()
    .from(SessionInputTable)
    .where(eq(SessionInputTable.session_id, SessionSchema.ID.make(facts.childID)))
    .all()
    .pipe(Effect.orDie)
  if (Hash.sha256(JSON.stringify(inputs)) !== facts.inputHash) return yield* Effect.die("Original input changed")
  const content = yield* Effect.promise(() => Bun.file(path.join(facts.directory, "unconfirmed.txt")).text())
  if (
    content !== "Unconfirmed child evidence\n" ||
    !git(["worktree", "list", "--porcelain"]).includes(`worktree ${facts.directory.replaceAll("\\", "/")}\n`)
  )
    return yield* Effect.die("Original physical workspace evidence was lost")
  if ((yield* TaskWorkspace.reclaimStale(db, { now: Date.now() + 86400000, retentionMs: 1 })).scanned !== 0)
    return yield* Effect.die("Nonterminal worktree became reclaimable")
  if ((yield* dispatcher.tick) !== 0) return yield* Effect.die("Quarantined task was dispatched again")
  if (
    (yield* db.select({ total: count() }).from(V2TaskRunReceiptTable).get().pipe(Effect.orDie))?.total !== 0 ||
    (yield* db.select({ total: count() }).from(TaskNotificationOutboxTable).get().pipe(Effect.orDie))?.total !== 0 ||
    locationAcquisitions !== 0
  )
    return yield* Effect.die("Unexpected child settlement or runner acquisition")
  console.log(
    JSON.stringify({
      phase,
      state: row.state,
      worktreeState: row.worktree_state,
      inputs: inputs.length,
      locationAcquisitions,
      terminalReceipts: 0,
      outbox: 0,
      dispatcher: 0,
    }),
  )
}).pipe(Effect.provide(stack), Effect.scoped, Effect.runPromise)
