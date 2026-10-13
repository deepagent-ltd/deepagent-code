import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { Cause, Deferred, Effect, Exit, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { IMTaskAuthority } from "@deepagent-code/core/im/task-authority"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionRestart } from "@deepagent-code/core/session/execution/restart"
import { SessionRuntimeStatus } from "@deepagent-code/core/session/runtime-status"
import { SessionRunCoordinator } from "@deepagent-code/core/session/run-coordinator"
import { SessionRunner } from "@deepagent-code/core/session/runner"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionStore } from "@deepagent-code/core/session/store"
import { IMTaskAuthorityFixture } from "../../../core/test/fixture/im-task-authority"
import { WorkAuthorityFixture } from "../../../core/test/fixture/work-authority"
import { IMTaskResultFixture } from "./fixture/task-result"
import { IMTaskControl } from "../../src/im/task-control"

const unused = () => Effect.die("Cancellation cannot schedule execution")

async function isolated(
  body: (input: {
    db: Database.Interface["db"]
    original: Effect.Success<ReturnType<typeof IMTaskResultFixture.prepare>>
    control: IMTaskControl.Interface
    coordinator: SessionRunCoordinator.Coordinator<SessionSchema.ID, void, SessionRunner.RunError>
    entered: Deferred.Deferred<void>
    interrupted: string[]
    stopped: string[]
  }) => Effect.Effect<void, unknown, IMTaskAuthority.Authority>,
) {
  const root = await mkdtemp("/tmp/dac-task-control-")
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const original = yield* IMTaskResultFixture.prepare({ directory: path.join(root, "project") })
        const db = (yield* Database.Service).db
        const entered = yield* Deferred.make<void>()
        const interrupted: string[] = []
        const stopped: string[] = []
        const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, void, SessionRunner.RunError>({
          drain: (id) =>
            Effect.gen(function* () {
              if (id === original.sessionID) yield* Deferred.succeed(entered, undefined)
              yield* Effect.never
            }).pipe(Effect.ensuring(Effect.sync(() => stopped.push(id)))),
        })
        const execution = Layer.succeed(
          SessionExecution.Service,
          SessionExecution.Service.of({
            active: coordinator.active,
            resume: unused,
            wake: unused,
            awaitIdle: coordinator.awaitIdle,
            interrupt: (id) =>
              Effect.gen(function* () {
                // The actual caller observes both durable fences before interrupting this owner.
                expect(yield* db.get("SELECT state,revision FROM im_task_grant")).toEqual({
                  state: "revoked",
                  revision: 2,
                })
                expect(yield* db.get("SELECT control_state,control_revision FROM work_execution")).toEqual({
                  control_state: "cancelled",
                  control_revision: 2,
                })
                interrupted.push(id)
                yield* coordinator.interrupt(id)
              }).pipe(Effect.orDie),
          }),
        )
        const restart = SessionRestart.layer.pipe(Layer.provide(SessionStore.layer), Layer.provide(execution))
        const runtime = SessionRuntimeStatus.layer.pipe(Layer.provide(restart), Layer.provide(execution))
        const control = yield* IMTaskControl.make.pipe(Effect.provide(runtime), Effect.provide(execution))
        yield* body({ db, original, control, coordinator, entered, interrupted, stopped })
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

test("offline expired grant commits cancellation before exact coordinator interruption and exact retry", () =>
  isolated(({ db, original, control, coordinator, entered, interrupted, stopped }) =>
    Effect.gen(function* () {
      yield* db.run("UPDATE test_task_source_proof SET active=0")
      yield* db.run("UPDATE test_task_target SET active=0")
      yield* db.run("DELETE FROM im_task_source")
      yield* coordinator.wake(SessionSchema.ID.make(original.sessionID))
      yield* Deferred.await(entered)
      const sibling = SessionSchema.ID.make("ses_unrelated_owner")
      yield* coordinator.wake(sibling)
      const input = {
        requestID: original.requestID,
        operationID: "cancel-original",
        expectedGrantRevision: 1,
        expectedControlRevision: 1,
        directory: original.context.directory,
      }
      const first = yield* control.cancel(input)
      expect(first.receipt).toMatchObject({
        requestID: original.requestID,
        grantID: original.grantID,
        workID: original.workID,
        sessionID: original.sessionID,
        grantRevision: 2,
        controlRevision: 2,
        controlState: "cancelled",
      })
      expect(first.state.source).toBeNull()
      expect(first.state.work).toMatchObject({ outcome: "succeeded", controlState: "cancelled", processActive: false })
      expect(stopped).toEqual([original.sessionID])
      expect((yield* coordinator.active).has(sibling)).toBe(true)
      const before = yield* db.get("SELECT outcome,control_receipts FROM work_execution")
      const exact = yield* control.cancel(input)
      expect(exact.receipt).toEqual(first.receipt)
      expect(yield* db.get("SELECT outcome,control_receipts FROM work_execution")).toEqual(before)
      expect(interrupted).toEqual([original.sessionID, original.sessionID])
      expect((yield* coordinator.active).has(sibling)).toBe(true)
    }),
  ))

test.each(["scope", "control_cas"] as const)(
  "failed %s cancels no owner and commits no partial grant revocation",
  (mode) =>
    isolated(({ db, original, control, interrupted }) =>
      Effect.gen(function* () {
        const exit = yield* control
          .cancel({
            requestID: original.requestID,
            operationID: "cancel-denied",
            expectedGrantRevision: 1,
            expectedControlRevision: mode === "control_cas" ? 99 : 1,
            directory: mode === "scope" ? path.join(original.context.directory, "foreign") : original.context.directory,
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toMatch(/project|revision|changed/i)
        expect(yield* db.get("SELECT state,revision FROM im_task_grant")).toEqual({ state: "active", revision: 1 })
        expect(yield* db.get("SELECT control_state,control_revision FROM work_execution")).toEqual({
          control_state: "active",
          control_revision: 1,
        })
        expect(interrupted).toEqual([])
      }),
    ),
)

test("cancelling an unknown Work retains its charged and reserved token facts", () =>
  isolated(({ db, original, control }) =>
    Effect.gen(function* () {
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
      const value = yield* control.cancel({
        requestID: original.requestID,
        operationID: "cancel-unknown",
        expectedGrantRevision: 1,
        expectedControlRevision: 1,
        directory: original.context.directory,
      })
      expect(value.state.work).toMatchObject({ outcome: "unknown", controlState: "cancelled", recoveryRequired: true })
      expect(yield* db.get("SELECT outcome FROM work_execution")).toEqual({ outcome: "unknown" })
      expect(yield* db.all("SELECT * FROM work_dispatch_reservation")).toEqual(ledger)
      expect(yield* db.get("SELECT state,reserved_total_tokens,charged_tokens FROM work_dispatch_reservation")).toEqual(
        { state: "unknown", reserved_total_tokens: 4137, charged_tokens: 4137 },
      )
    }),
  ))
