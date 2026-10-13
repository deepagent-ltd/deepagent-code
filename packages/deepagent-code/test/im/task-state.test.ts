import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { IMTaskAuthority } from "@deepagent-code/core/im/task-authority"
import { IMTaskAuthoritySchema } from "@deepagent-code/core/im/task-authority.schema"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionRestart } from "@deepagent-code/core/session/execution/restart"
import { SessionRuntimeStatus } from "@deepagent-code/core/session/runtime-status"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionStore } from "@deepagent-code/core/session/store"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { IMTaskAuthorityFixture } from "../../../core/test/fixture/im-task-authority"
import { WorkAuthorityFixture } from "../../../core/test/fixture/work-authority"
import { IMTaskResultFixture } from "./fixture/task-result"
import { IMTaskState } from "../../src/im/task-state"

const unused = () => Effect.die("A management read must not execute or interrupt a Session")

async function isolated(
  body: (input: {
    db: Database.Interface["db"]
    original: Effect.Success<ReturnType<typeof IMTaskResultFixture.prepare>>
    state: IMTaskState.Interface
  }) => Effect.Effect<void, unknown, IMTaskAuthority.Authority>,
) {
  const root = await mkdtemp("/tmp/dac-task-state-")
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const original = yield* IMTaskResultFixture.prepare({ directory: path.join(root, "project") })
        const db = (yield* Database.Service).db
        const execution = Layer.succeed(
          SessionExecution.Service,
          SessionExecution.Service.of({
            active: Effect.succeed(new Set<SessionSchema.ID>()),
            resume: unused,
            wake: unused,
            interrupt: unused,
            awaitIdle: unused,
          }),
        )
        const restart = SessionRestart.layer.pipe(Layer.provide(SessionStore.layer), Layer.provide(execution))
        const runtime = SessionRuntimeStatus.layer.pipe(Layer.provide(restart), Layer.provide(execution))
        const state = yield* IMTaskState.make.pipe(Effect.provide(runtime), Effect.provide(execution))
        yield* body({ db, original, state })
      }).pipe(
        Effect.provide(IMTaskAuthorityFixture.authority),
        Effect.provide(WorkAuthorityFixture.database(path.join(root, "private.sqlite"))),
        Effect.scoped,
      ),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function rows(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    const tables = yield* db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    return yield* Effect.forEach(tables, (table) =>
      db
        .all<Record<string, unknown>>(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`)
        .pipe(
          Effect.map((records) => [table.name, records.map((row) => Hash.sha256(CanonicalJson.stringify(row))).sort()]),
        ),
    )
  })
}

test("expired source and offline authority do not renew or execute an owned durable state read", () =>
  isolated(({ db, original, state }) =>
    Effect.gen(function* () {
      yield* db.run("UPDATE test_task_source_proof SET active=0")
      yield* db.run("UPDATE test_task_target SET active=0")
      const before = yield* rows(db)
      const value = yield* state.read({ requestID: original.requestID, directory: original.context.directory })
      expect(value).toMatchObject({
        requestID: original.requestID,
        instanceID: original.instanceID,
        grant: { state: "active", revision: 1 },
        work: {
          workID: original.workID,
          outcome: "succeeded",
          controlState: "active",
          hasExecutionClaim: false,
          processActive: false,
          recoveryRequired: false,
        },
        delivery: { outboxStatus: "delivered", receiptState: null },
      })
      expect(value.grant!.expiresAt).toBeLessThan(Date.now())
      expect(yield* rows(db)).toEqual(before)
      yield* db.run("DELETE FROM im_task_source")
      const cleaned = yield* rows(db)
      const retained = yield* state.read({ requestID: original.requestID, directory: original.context.directory })
      expect(retained.source).toBeNull()
      expect(retained.work?.workID).toBe(original.workID)
      expect(yield* rows(db)).toEqual(cleaned)
    }),
  ))

test.each(["directory", "principal", "body", "binding"] as const)(
  "management state rejects changed %s without query writes",
  (mode) =>
    isolated(({ db, original, state }) =>
      Effect.gen(function* () {
        if (mode === "principal")
          yield* db.run(
            sql`UPDATE test_task_operator SET principal=${JSON.stringify({
              ...IMTaskAuthorityFixture.principal,
              instanceID: original.instanceID,
              actorID: "foreign-operator",
            })}`,
          )
        if (mode === "body") yield* db.run("UPDATE im_task_request SET audited_text='changed immutable request text'")
        if (mode === "binding") yield* db.run(sql`UPDATE work_execution SET binding_hash=${"e".repeat(64)}`)
        const before = yield* rows(db)
        const exit = yield* state
          .read({
            requestID: original.requestID,
            directory:
              mode === "directory" ? path.join(original.context.directory, "foreign") : original.context.directory,
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause)
          expect(error).toBeInstanceOf(IMTaskAuthoritySchema.Error)
          if (error instanceof IMTaskAuthoritySchema.Error)
            expect(error.code).toBe(
              mode === "directory"
                ? "IM_TASK_FORBIDDEN"
                : mode === "principal"
                  ? "IM_TASK_NOT_VISIBLE"
                  : "IM_TASK_IDENTITY_CONFLICT",
            )
        }
        expect(yield* rows(db)).toEqual(before)
      }),
    ),
)

test("unknown Work keeps its escrow and business outcome in a read-only recovery projection", () =>
  isolated(({ db, original, state }) =>
    Effect.gen(function* () {
      // Controlled persisted unknown outcome; this does not claim a Native physical failure.
      yield* db.run("UPDATE work_execution SET outcome='unknown'")
      // Controlled durable ledger fixture, not a claim that a Native request was dispatched.
      yield* db.run(`INSERT INTO work_dispatch_reservation
      (reservation_id,work_id,root_work_id,kind,dispatch_key,request_hash,receipt_id,attempt_id,
       session_claim_token,owner_token,control_revision,context_selection_id,context_projection_hash,
       state,input_bound,reserved_input_tokens,reserved_completion_tokens,reserved_total_tokens,
       charged_tokens,wire_hash,endpoint,created_at,dispatching_at)
      SELECT 'controlled-unknown',work_id,root_work_id,'provider','controlled-dispatch',
       '${"a".repeat(64)}','controlled-receipt','controlled-attempt',7,'controlled-owner',1,
       'controlled-selection','${"b".repeat(64)}','unknown',
       '{"tokens":41,"kind":"exact","evidenceID":"controlled-bound","evidenceHash":"${"c".repeat(64)}"}',
       41,4096,4137,4137,'${"d".repeat(64)}','https://controlled.invalid/v1/chat/completions',1,2
      FROM work_execution`)
      const ledger = yield* db.all("SELECT * FROM work_dispatch_reservation")
      const before = yield* rows(db)
      const value = yield* state.read({ requestID: original.requestID, directory: original.context.directory })
      expect(value.work).toMatchObject({
        outcome: "unknown",
        recoveryRequired: true,
        hasExecutionClaim: false,
        sessionRecoveryRequired: false,
        dispatchUnknown: 1,
      })
      expect(yield* db.get("SELECT outcome FROM work_execution")).toEqual({ outcome: "unknown" })
      expect(yield* db.all("SELECT * FROM work_dispatch_reservation")).toEqual(ledger)
      expect(yield* db.get("SELECT state,reserved_total_tokens,charged_tokens FROM work_dispatch_reservation")).toEqual(
        { state: "unknown", reserved_total_tokens: 4137, charged_tokens: 4137 },
      )
      expect(yield* rows(db)).toEqual(before)
    }),
  ))
