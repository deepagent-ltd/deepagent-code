import { Cause, Effect, Exit } from "effect"
import { Database } from "../../src/database/database"
import { WorkAuthority } from "../../src/session/work-authority"
import { WorkAuthoritySchema } from "../../src/session/work-authority.schema"
import { WorkAuthorityFixture } from "./work-authority"

const filename = process.env.WORK_AUTHORITY_PROCESS_DB
const mode = process.env.WORK_AUTHORITY_PROCESS_MODE
if (!filename || !["writer", "reader"].includes(mode ?? ""))
  throw new Error("Private process fixture arguments are required")

await Effect.runPromise(
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const input = WorkAuthorityFixture.binding()
    if (mode === "writer") {
      yield* WorkAuthorityFixture.initialize()
      yield* WorkAuthority.reserve(db, { binding: input, now: WorkAuthorityFixture.NOW })
      yield* WorkAuthorityFixture.materialize(input)
      const reservation = yield* db.transaction(
        (tx) => WorkAuthority.reserveDispatchInTransaction(tx, WorkAuthorityFixture.dispatch(input)),
        { behavior: "immediate" },
      )
      yield* db.transaction(
        (tx) => WorkAuthority.authorizeDispatchInTransaction(tx, WorkAuthorityFixture.seal(reservation)),
        { behavior: "immediate" },
      )
      // The process is killed with the permit in flight, before any trusted terminal receipt.
      // This exercises the store authority, not a provider or the SessionExecution bootstrap.
      console.log(JSON.stringify({ phase: "committed", pid: process.pid, state: "dispatching" }))
      return yield* Effect.never
    }
    const runnable = yield* WorkAuthority.requireContext(db, {
      sessionID: input.sessionID,
      now: WorkAuthorityFixture.NOW,
    }).pipe(Effect.exit)
    const retry = yield* db
      .transaction((tx) => WorkAuthority.reserveDispatchInTransaction(tx, WorkAuthorityFixture.dispatch(input)), {
        behavior: "immediate",
      })
      .pipe(Effect.exit)
    const rows = yield* db.all<{ state: string; charge: number }>(
      "SELECT state, charged_tokens charge FROM work_dispatch_reservation",
    )
    const code = (exit: Exit.Exit<unknown, unknown>) => {
      if (Exit.isSuccess(exit)) return "success"
      const error = Cause.squash(exit.cause)
      return error instanceof WorkAuthoritySchema.Error ? error.code : "unexpected_failure"
    }
    console.log(
      JSON.stringify({ phase: "reopened", pid: process.pid, runnable: code(runnable), retry: code(retry), rows }),
    )
  }).pipe(
    Effect.provide(WorkAuthorityFixture.verifier),
    Effect.provide(WorkAuthorityFixture.database(filename)),
    Effect.scoped,
  ),
)
