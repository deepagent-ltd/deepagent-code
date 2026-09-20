#!/usr/bin/env bun

// Crash-simulation fixture for test/task-run-authority.test.ts. The application Database layer
// memoizes per process, so "close the connection and reopen" needs a real second process: the
// "admit" phase commits the ledger transaction and exits (crash point: between the ledger commit
// and the child create); the "recover" phase reopens the same file and converges by adoption.
// Assertions also run here (exit non-zero on failure); the parent test checks facts + exit codes.

import { Effect, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { ProjectV2 } from "@deepagent-code/core/project"
import { count, eq } from "drizzle-orm"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionInputTable, SessionTable } from "@deepagent-code/core/session/sql"
import { TaskRunAuthority } from "@deepagent-code/core/session/task-run"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionStore } from "@deepagent-code/core/session/store"
import { SessionV2 } from "@deepagent-code/core/session"

const filename = process.argv[2]!
// A stub project service: the real Project.defaultLayer bundles Database.defaultLayer (the
// process-global default path), and building it can hijack the memoized Database layer away from
// this fixture's file. The fixture needs only a deterministic project identity for the session.
const project = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    directories: () => Effect.succeed([]),
    resolve: (directory) =>
      Effect.succeed({
        id: ProjectV2.ID.make("prj_taskrun_crash_fixture"),
        directory,
      }),
    commit: () => Effect.void,
  }),
)

const database = Database.layerFromPath(filename)
const events = EventV2.layer.pipe(Layer.provide(database))
const stack = Layer.mergeAll(
  database,
  events,
  SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database)),
  SessionV2.layer.pipe(
    Layer.provide(events),
    Layer.provide(database),
    Layer.provide(SessionStore.layer.pipe(Layer.provide(database))),
    Layer.provide(project),
    Layer.provide(SessionExecution.noopLayer),
  ),
)
const phase = process.argv[3]!
const parentID = SessionSchema.ID.make(process.argv[4]!)
const directory = AbsolutePath.make("/tmp")
const spec = {
  parentSessionID: parentID,
  parentMessageID: SessionMessage.ID.make("msg_parent_call-crash-1"),
  toolCallID: "call-crash-1",
  deliveryMode: "foreground" as const,
  prompt: new Prompt({ text: "Research the durable crash boundary." }),
  agent: "general",
  child: {
    title: "task: crash fixture",
    location: { directory },
    permissions: [{ action: "edit", resource: "*", effect: "deny" as const }],
  },
}

const gen = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const events = yield* EventV2.Service
  const sessions = yield* SessionV2.Service
  if (phase === "admit") {
    yield* sessions.create({ id: parentID, location: { directory } })
    const admitted = yield* TaskRunAuthority.admitRun(db, spec)
    console.log(`RUN_ID=${admitted.run.runID}`)
    console.log(`CHILD_SESSION_ID=${admitted.run.childSessionID}`)
    return
  }
  const run = yield* TaskRunAuthority.getByAdmission(db, spec)
  if (!run) throw new Error("ledger row missing after reopen")
  if (run.state !== "admitted" || run.inputState !== "pending") {
    throw new Error(`unexpected run state after reopen: ${run.state}/${run.inputState}`)
  }
  const before = yield* db
    .select({ total: count() })
    .from(SessionTable)
    .where(eq(SessionTable.parent_id, parentID))
    .get()
    .pipe(Effect.orDie)
  if (before?.total !== 0) throw new Error("child session already exists before recovery")

  yield* TaskRunAuthority.ensureChildSession(db, sessions, spec, run)
  yield* TaskRunAuthority.ensureChildSession(db, sessions, spec, run)
  const children = yield* db
    .select({ id: SessionTable.id })
    .from(SessionTable)
    .where(eq(SessionTable.parent_id, parentID))
    .all()
    .pipe(Effect.orDie)
  if (children.length !== 1 || children[0]?.id !== run.childSessionID) {
    throw new Error(`adoption diverged: ${JSON.stringify(children)}`)
  }
  yield* TaskRunAuthority.admitChildInput(db, events, run, spec.prompt)
  const ready = yield* TaskRunAuthority.get(db, run.runID)
  if (ready?.inputState !== "ready") throw new Error(`input CAS did not converge: ${ready?.inputState}`)
  const inputs = yield* db
    .select({ total: count() })
    .from(SessionInputTable)
    .where(eq(SessionInputTable.session_id, run.childSessionID))
    .get()
    .pipe(Effect.orDie)
  if (inputs?.total !== 1) throw new Error(`session_input rows: ${inputs?.total}`)
  console.log("RECOVERED_OK")
})
await Effect.runPromise(gen.pipe(Effect.provide(stack), Effect.scoped))
