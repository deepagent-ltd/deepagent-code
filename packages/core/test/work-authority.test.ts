import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Database } from "../src/database/database"
import { WorkAuthority } from "../src/session/work-authority"
import { WorkAuthoritySchema } from "../src/session/work-authority.schema"
import { Hash } from "../src/util/hash"
import { CanonicalJson } from "../src/util/canonical-json"
import { WorkAuthorityFixture } from "./fixture/work-authority"

function run<A, E>(filename: string, effect: Effect.Effect<A, E, Database.Service>) {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(WorkAuthorityFixture.verifier),
      Effect.provide(WorkAuthorityFixture.database(filename)),
      Effect.scoped,
    ),
  )
}

function errorCode<A, E>(exit: Exit.Exit<A, E>) {
  if (Exit.isSuccess(exit)) return "success"
  const error = Cause.squash(exit.cause)
  return error instanceof WorkAuthoritySchema.Error ? error.code : String(error)
}

async function isolated(body: (filename: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "work-authority-store-"))
  try {
    const filename = join(root, "authority.sqlite")
    await run(filename, WorkAuthorityFixture.initialize())
    await body(filename)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("work authority actual SQLite store", () => {
  test("reserve is exact, exclusive and unavailable without a trusted verifier", () =>
    isolated(async (filename) => {
      const unavailable = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* WorkAuthority.reserve((yield* Database.Service).db, {
            binding: WorkAuthorityFixture.binding(),
            now: WorkAuthorityFixture.NOW,
          }).pipe(Effect.exit)
        }).pipe(Effect.provide(WorkAuthorityFixture.database(filename)), Effect.scoped),
      )
      expect(errorCode(unavailable)).toBe("PROFILE_UNAVAILABLE")
      await run(
        filename,
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const input = WorkAuthorityFixture.binding()
          const first = yield* WorkAuthority.reserve(db, { binding: input, now: WorkAuthorityFixture.NOW })
          expect(first.admission_state).toBe("reserved")
          expect(
            (yield* WorkAuthority.reserve(db, { binding: input, now: WorkAuthorityFixture.NOW + 1 })).binding_hash,
          ).toBe(first.binding_hash)
          expect(
            errorCode(
              yield* WorkAuthority.reserve(db, {
                binding: { ...input, budget: { ...input.budget, maxTotalTokens: 7_999 } },
                now: WorkAuthorityFixture.NOW,
              }).pipe(Effect.exit),
            ),
          ).toBe("WORK_REQUEST_CONFLICT")
          expect(
            errorCode(
              yield* WorkAuthority.requireContext(db, {
                sessionID: input.sessionID,
                now: WorkAuthorityFixture.NOW,
              }).pipe(Effect.exit),
            ),
          ).toBe("WORK_NOT_READY")
        }),
      )
    }))

  test("queue input and ready binding roll back together on stale source authority", () =>
    isolated(async (filename) => {
      await run(
        filename,
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const input = WorkAuthorityFixture.binding()
          yield* WorkAuthority.reserve(db, { binding: input, now: WorkAuthorityFixture.NOW })
          yield* db.run("UPDATE test_work_source SET enabled = 0")
          expect(errorCode(yield* WorkAuthorityFixture.materialize(input).pipe(Effect.exit))).toBe("WORK_REVOKED")
          expect((yield* db.all<{ count: number }>("SELECT count(*) count FROM session_input"))[0]?.count).toBe(0)
          expect((yield* WorkAuthority.get(db, input.workID))?.admission_state).toBe("reserved")
        }),
      )
    }))

  test("current source revocation blocks Context independently of later seal checks", () =>
    isolated(async (filename) => {
      await run(
        filename,
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const input = WorkAuthorityFixture.binding()
          yield* WorkAuthority.reserve(db, { binding: input, now: WorkAuthorityFixture.NOW })
          yield* WorkAuthorityFixture.materialize(input)
          expect(
            (yield* WorkAuthority.requireContext(db, {
              sessionID: input.sessionID,
              location: input.location,
              now: WorkAuthorityFixture.NOW,
            }))?.work_id,
          ).toBe(input.workID)
          yield* db.run("UPDATE test_work_source SET enabled = 0")
          expect(
            errorCode(
              yield* WorkAuthority.requireContext(db, {
                sessionID: input.sessionID,
                now: WorkAuthorityFixture.NOW,
              }).pipe(Effect.exit),
            ),
          ).toBe("WORK_REVOKED")
        }),
      )
    }))

  for (const authority of ["source", "route"] as const) {
    test(`a revoked ${authority} cannot reserve quota after Context validation`, () =>
      isolated(async (filename) => {
        await run(filename, Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const input = WorkAuthorityFixture.binding()
          yield* WorkAuthority.reserve(db, { binding: input, now: WorkAuthorityFixture.NOW })
          yield* WorkAuthorityFixture.materialize(input)
          yield* WorkAuthority.requireContext(db, { sessionID: input.sessionID, now: WorkAuthorityFixture.NOW })
          yield* db.run(authority === "source" ? "UPDATE test_work_source SET enabled = 0" : "UPDATE test_work_route SET enabled = 0")
          const refused = yield* db.transaction(
            (tx) => WorkAuthority.reserveDispatchInTransaction(tx, WorkAuthorityFixture.dispatch(input)),
            { behavior: "immediate" },
          ).pipe(Effect.exit)
          expect(errorCode(refused)).toBe(authority === "source" ? "WORK_REVOKED" : "PROFILE_UNAVAILABLE")
          expect((yield* db.all<{ count: number }>("SELECT count(*) count FROM work_dispatch_reservation"))[0]?.count).toBe(0)
          expect((yield* WorkAuthority.get(db, input.workID))?.outcome).toBe("pending")
        }))
      }),
    )
  }

  test("reservation identities, Context, claim, endpoint and source are rechecked before one-way permit", () =>
    isolated(async (filename) => {
      await run(
        filename,
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const input = WorkAuthorityFixture.binding()
          yield* WorkAuthority.reserve(db, { binding: input, now: WorkAuthorityFixture.NOW })
          yield* WorkAuthorityFixture.materialize(input)
          const reservation = yield* db.transaction(
            (tx) => WorkAuthority.reserveDispatchInTransaction(tx, WorkAuthorityFixture.dispatch(input)),
            { behavior: "immediate" },
          )
          expect(
            (yield* db.transaction(
              (tx) => WorkAuthority.reserveDispatchInTransaction(tx, WorkAuthorityFixture.dispatch(input)),
              { behavior: "immediate" },
            )).reservation_id,
          ).toBe(reservation.reservation_id)
          expect(
            errorCode(
              yield* db
                .transaction(
                  (tx) =>
                    WorkAuthority.reserveDispatchInTransaction(tx, {
                      ...WorkAuthorityFixture.dispatch(input),
                      completionTokens: 1,
                    }),
                  { behavior: "immediate" },
                )
                .pipe(Effect.exit),
            ),
          ).toBe("WORK_DISPATCH_CONFLICT")
          for (const patch of [
            { endpoint: "https://other.test/v1" },
            { method: undefined },
            { contextProjectionHash: "f".repeat(64) },
          ])
            expect(
              Exit.isFailure(
                yield* db
                  .transaction(
                    (tx) =>
                      WorkAuthority.authorizeDispatchInTransaction(tx, {
                        ...WorkAuthorityFixture.seal(reservation),
                        ...patch,
                      }),
                    { behavior: "immediate" },
                  )
                  .pipe(Effect.exit),
              ),
            ).toBe(true)
          yield* db.run(sql`UPDATE session SET execution_claim_token = 8 WHERE id = ${input.sessionID}`)
          expect(
            errorCode(
              yield* db
                .transaction(
                  (tx) => WorkAuthority.authorizeDispatchInTransaction(tx, WorkAuthorityFixture.seal(reservation)),
                  { behavior: "immediate" },
                )
                .pipe(Effect.exit),
            ),
          ).toBe("WORK_BINDING_CONFLICT")
          yield* db.run(sql`UPDATE session SET execution_claim_token = 7 WHERE id = ${input.sessionID}`)
          const permit = yield* db.transaction(
            (tx) => WorkAuthority.authorizeDispatchInTransaction(tx, WorkAuthorityFixture.seal(reservation)),
            { behavior: "immediate" },
          )
          expect(permit.state).toBe("dispatching")
          expect(
            errorCode(
              yield* db
                .transaction(
                  (tx) => WorkAuthority.authorizeDispatchInTransaction(tx, WorkAuthorityFixture.seal(reservation)),
                  { behavior: "immediate" },
                )
                .pipe(Effect.exit),
            ),
          ).toBe("WORK_DISPATCH_CONFLICT")
          const settled = yield* db.transaction(
            (tx) =>
              WorkAuthority.settleDispatchInTransaction(tx, {
                reservationID: reservation.reservation_id,
                outcome: "settled",
                usage: { inputTokens: 100, completionTokens: 60, reasoningTokens: 40 },
                now: WorkAuthorityFixture.NOW,
              }),
            { behavior: "immediate" },
          )
          expect(settled.charged_tokens).toBe(160)
          expect(
            errorCode(
              yield* WorkAuthority.requireRunnable(db, {
                sessionID: input.sessionID,
                now: WorkAuthorityFixture.NOW,
              }).pipe(Effect.exit),
            ),
          ).toBe("WORK_BUDGET_EXHAUSTED")
        }),
      )
    }))

  test("revoke and dispatch serialize: revoke-first means no permit, dispatch-first remains in flight", () =>
    isolated(async (filename) => {
      await run(
        filename,
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          for (const suffix of ["one", "two"]) {
            const input = {
              ...WorkAuthorityFixture.binding(suffix),
              scope: { ...WorkAuthorityFixture.binding(suffix).scope, securityNamespaceID: suffix },
            }
            yield* WorkAuthority.reserve(db, { binding: input, now: WorkAuthorityFixture.NOW })
            yield* WorkAuthorityFixture.materialize(input)
            const reservation = yield* db.transaction(
              (tx) => WorkAuthority.reserveDispatchInTransaction(tx, WorkAuthorityFixture.dispatch(input)),
              { behavior: "immediate" },
            )
            if (suffix === "two")
              yield* db.transaction(
                (tx) => WorkAuthority.authorizeDispatchInTransaction(tx, WorkAuthorityFixture.seal(reservation)),
                { behavior: "immediate" },
              )
            const command = {
              workID: input.workID,
              requestID: "revoke-one",
              expectedRevision: 1,
              action: "revoke" as const,
              now: WorkAuthorityFixture.NOW,
            }
            const first = yield* WorkAuthority.control(db, command)
            expect((yield* WorkAuthority.control(db, command)).receipt).toEqual(first.receipt)
            expect(
              errorCode(
                yield* db
                  .transaction(
                    (tx) => WorkAuthority.authorizeDispatchInTransaction(tx, WorkAuthorityFixture.seal(reservation)),
                    { behavior: "immediate" },
                  )
                  .pipe(Effect.exit),
              ),
            ).toBe("WORK_CONTROL_CONFLICT")
            expect(
              (yield* db.all<{ state: string }>(
                sql`SELECT state FROM work_dispatch_reservation WHERE reservation_id = ${reservation.reservation_id}`,
              ))[0]?.state,
            ).toBe(suffix === "two" ? "dispatching" : "reserved")
          }
        }),
      )
    }))

  test("two real file connections race for the final namespace budget without copying allowance", () =>
    isolated(async (filename) => {
      const inputs = [WorkAuthorityFixture.binding("one"), WorkAuthorityFixture.binding("two")]
      await run(
        filename,
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          for (const input of inputs) {
            yield* WorkAuthority.reserve(db, { binding: input, now: WorkAuthorityFixture.NOW })
            yield* WorkAuthorityFixture.materialize(input)
          }
        }),
      )
      const results = await Promise.all(
        inputs.map((input) =>
          run(
            filename,
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db
                .transaction(
                  (tx) => WorkAuthority.reserveDispatchInTransaction(tx, WorkAuthorityFixture.dispatch(input)),
                  { behavior: "immediate" },
                )
                .pipe(Effect.exit)
            }),
          ),
        ),
      )
      expect(results.map(errorCode).sort()).toEqual(["WORK_BUDGET_EXHAUSTED", "success"])
      await run(
        filename,
        Effect.gen(function* () {
          expect(
            (yield* (yield* Database.Service).db.all<{ count: number; charge: number }>(
              "SELECT count(*) count, sum(charged_tokens) charge FROM work_dispatch_reservation",
            ))[0],
          ).toEqual({ count: 1, charge: 5_120 })
        }),
      )
    }))

  test("unknown persists across file reopen and cannot be reset by resume, retry, release or settlement", () =>
    isolated(async (filename) => {
      const input = WorkAuthorityFixture.binding()
      const id = await run(
        filename,
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
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
          yield* db.transaction(
            (tx) =>
              WorkAuthority.settleDispatchInTransaction(tx, {
                reservationID: reservation.reservation_id,
                outcome: "unknown",
                now: WorkAuthorityFixture.NOW,
              }),
            { behavior: "immediate" },
          )
          return reservation.reservation_id
        }),
      )
      await run(
        filename,
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          expect(
            errorCode(
              yield* WorkAuthority.requireContext(db, {
                sessionID: input.sessionID,
                now: WorkAuthorityFixture.NOW,
              }).pipe(Effect.exit),
            ),
          ).toBe("WORK_RECOVERY_REQUIRED")
          expect(
            errorCode(
              yield* db
                .transaction(
                  (tx) => WorkAuthority.settleDispatchInTransaction(tx, { reservationID: id, outcome: "released" }),
                  { behavior: "immediate" },
                )
                .pipe(Effect.exit),
            ),
          ).toBe("WORK_RECOVERY_REQUIRED")
          expect(
            errorCode(
              yield* db
                .transaction(
                  (tx) =>
                    WorkAuthority.settleDispatchInTransaction(tx, {
                      reservationID: id,
                      outcome: "settled",
                      usage: { inputTokens: 1, completionTokens: 1 },
                    }),
                  { behavior: "immediate" },
                )
                .pipe(Effect.exit),
            ),
          ).toBe("WORK_RECOVERY_REQUIRED")
          expect(
            (yield* db.all<{ state: string; charge: number }>(
              sql`SELECT state, charged_tokens charge FROM work_dispatch_reservation WHERE reservation_id = ${id}`,
            ))[0],
          ).toEqual({ state: "unknown", charge: 5_120 })
        }),
      )
    }))
})

test("admission retry checks current proof and rejects non-text prompt authority", () =>
  isolated(async (filename) => {
    await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        for (const [index, prompt] of [
          { text: WorkAuthorityFixture.TEXT, files: [{ uri: "file:///private/file", mime: "text/plain" }] },
          { text: WorkAuthorityFixture.TEXT, references: [] },
          { text: WorkAuthorityFixture.TEXT, metadata: { unrestricted: true } },
          { text: WorkAuthorityFixture.TEXT, agent: "different" },
          { text: WorkAuthorityFixture.TEXT, model: { id: "different", providerID: "test-provider" } },
          {
            text: WorkAuthorityFixture.TEXT,
            model: { id: "deterministic", providerID: "test-provider", variant: "wide" },
          },
        ].entries()) {
          const input = WorkAuthorityFixture.binding(`bad-${index}`)
          yield* WorkAuthority.reserve(db, { binding: input, now: WorkAuthorityFixture.NOW })
          expect(errorCode(yield* WorkAuthorityFixture.materialize(input, prompt).pipe(Effect.exit))).toBe(
            "WORK_BINDING_CONFLICT",
          )
        }
        expect((yield* db.all<{ count: number }>("SELECT count(*) count FROM session_input"))[0]?.count).toBe(0)
        const input = WorkAuthorityFixture.binding()
        yield* WorkAuthority.reserve(db, { binding: input, now: WorkAuthorityFixture.NOW })
        expect(
          (yield* WorkAuthority.requireAdmission(db, { workID: input.workID, now: WorkAuthorityFixture.NOW }))
            .admission_state,
        ).toBe("reserved")
        yield* WorkAuthorityFixture.materialize(input)
        expect(
          (yield* WorkAuthority.requireAdmission(db, { workID: input.workID, now: WorkAuthorityFixture.NOW }))
            .admission_state,
        ).toBe("ready")
        yield* db.run("UPDATE test_work_source SET enabled = 0")
        expect(
          errorCode(
            yield* WorkAuthority.requireAdmission(db, { workID: input.workID, now: WorkAuthorityFixture.NOW }).pipe(
              Effect.exit,
            ),
          ),
        ).toBe("WORK_REVOKED")
      }),
    )
  }))

test("legacy discovery requires durable event, DAG or IM facts, including descendants", () =>
  isolated(async (filename) => {
    await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* db.run(
          "INSERT INTO project (id,worktree,sandboxes,time_created,time_updated) VALUES ('legacy-project','/tmp/legacy','[]',1,1)",
        )
        const dagID = `ses_v4_${Hash.sha256(CanonicalJson.stringify(["event-turn-session", "dag-event", "dag-task", 1])).slice(0, 40)}`
        for (const [id, parent] of [
          ["event-session", null],
          ["event-child", "event-session"],
          ["dag-session", null],
          ["dag-child", "dag-session"],
          [dagID, null],
          ["dag-running-child", dagID],
          ["im-session", null],
          ["im-child", "im-session"],
          ["im-input-session", null],
          ["ordinary", null],
          ["metadata-only", null],
        ]) {
          yield* db.run(
            sql`INSERT INTO session (id,project_id,slug,directory,title,version,metadata,parent_id,time_created,time_updated) VALUES (${id},'legacy-project',${id},'/tmp/legacy','legacy','2',${JSON.stringify({ eventID: "dag-event", taskID: "dag-task", generation: 1 })},${parent},1,1)`,
          )
        }
        yield* db.run(
          sql`INSERT INTO deepagent_event_admission (event_ref,session_id,envelope_digest,status,envelope_json,admitted_at,updated_at) VALUES ('event-one','event-session',${"a".repeat(64)},'resolved','{}',1,1)`,
        )
        yield* db.run(
          sql`INSERT INTO deepagent_agent_execution (workspace_id,event_id,task_id,status,generation,artifacts,tokens_used,created_at,updated_at) VALUES ('workspace','dag-event','dag-task','running',1,${JSON.stringify(["session:dag-session"])},0,1,1)`,
        )
        yield* db.run(
          "INSERT INTO im_groups (id,workspace_id,type,name,created_by,created_at,updated_at) VALUES ('im-group','workspace','project','fixture','user',1,1)",
        )
        yield* db.run(
          "INSERT INTO im_messages (id,group_id,sender_id,sender_type,type,content,created_at,updated_at) VALUES ('im-message','im-group','user','user','text','text',1,1)",
        )
        yield* db.run(
          sql`INSERT INTO session_input (id,session_id,prompt,delivery,admitted_seq,time_created) VALUES ('im-input','im-input-session',${JSON.stringify({ text: "text" })},'steer',1,1)`,
        )
        yield* db.run(
          "INSERT INTO im_mention_intent (id,message_id,agent_name,directory,workspace_id,user_id,origin,session_id,status,created_at,updated_at) VALUES ('intent-one','im-message','agent-one','/tmp/legacy','workspace','user','kernel_live','im-session','admitted',1,1)",
        )
        yield* db.run(
          "INSERT INTO im_mention_intent (id,message_id,agent_name,directory,workspace_id,user_id,origin,input_id,status,created_at,updated_at) VALUES ('intent-two','im-message','agent-two','/tmp/legacy','workspace','user','local','im-input','admitted',1,1)",
        )
        for (const id of [
          "event-session",
          "event-child",
          "dag-session",
          "dag-child",
          dagID,
          "dag-running-child",
          "im-session",
          "im-child",
          "im-input-session",
        ])
          expect((yield* WorkAuthority.lookupSession(db, id)).kind).toBe("legacy_unbound")
        for (const id of ["ordinary", "metadata-only", "ses_im_fake", "missing"])
          expect((yield* WorkAuthority.lookupSession(db, id)).kind).toBe("ordinary")
      }),
    )
  }))

test("a revoked final proof rolls back the whole caller transaction before dispatch", () =>
  isolated(async (filename) => {
    await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const input = WorkAuthorityFixture.binding()
        yield* WorkAuthority.reserve(db, { binding: input, now: WorkAuthorityFixture.NOW })
        yield* WorkAuthorityFixture.materialize(input)
        const reservation = yield* db.transaction(
          (tx) => WorkAuthority.reserveDispatchInTransaction(tx, WorkAuthorityFixture.dispatch(input)),
          { behavior: "immediate" },
        )
        yield* db.run("UPDATE test_work_route SET enabled = 0")
        const result = yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                yield* tx.run("UPDATE session SET title = 'must roll back'")
                yield* WorkAuthority.authorizeDispatchInTransaction(tx, WorkAuthorityFixture.seal(reservation))
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.exit)
        expect(errorCode(result)).toBe("PROFILE_UNAVAILABLE")
        expect((yield* db.all<{ title: string }>("SELECT title FROM session"))[0]?.title).toBe("Work fixture")
        expect((yield* db.all<{ state: string }>("SELECT state FROM work_dispatch_reservation"))[0]?.state).toBe(
          "reserved",
        )
      }),
    )
  }))

test("SIGKILL after the durable permit cannot recreate an allowance in a new process", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-authority-process-"))
  const env = {
    PATH: process.env.PATH,
    HOME: join(root, "home"),
    TMPDIR: join(root, "tmp"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    WORK_AUTHORITY_PROCESS_DB: join(root, "authority.sqlite"),
  }
  await Promise.all(["home", "tmp", "config", "data", "cache"].map((name) => mkdir(join(root, name))))
  const fixture = join(import.meta.dir, "fixture/work-authority-process.ts")
  const writer = Bun.spawn([process.execPath, fixture], {
    cwd: dirname(fixture),
    env: { ...env, WORK_AUTHORITY_PROCESS_MODE: "writer" },
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const reader = writer.stdout.getReader()
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Writer did not commit in time")), 15_000)),
    ])
    const committed = JSON.parse(new TextDecoder().decode(first.value))
    expect(committed).toMatchObject({ phase: "committed", state: "dispatching", pid: writer.pid })
    writer.kill("SIGKILL")
    await writer.exited
    expect(writer.signalCode).toBe("SIGKILL")
    for (const index of [1, 2]) {
      const observer = Bun.spawn([process.execPath, fixture], {
        cwd: dirname(fixture),
        env: { ...env, WORK_AUTHORITY_PROCESS_MODE: "reader" },
        stdout: "pipe",
        stderr: "pipe",
      })
      const output = await new Response(observer.stdout).text()
      const stderr = await new Response(observer.stderr).text()
      expect(await observer.exited).toBe(0)
      expect(stderr).toBe("")
      expect(JSON.parse(output)).toMatchObject({
        phase: "reopened",
        pid: observer.pid,
        runnable: "WORK_RECOVERY_REQUIRED",
        retry: "WORK_RECOVERY_REQUIRED",
        rows: [{ state: "dispatching", charge: 5_120 }],
      })
      expect(observer.pid).not.toBe(writer.pid)
      console.log(`work authority P${index + 1}: pid=${observer.pid} retained in-flight charge=5120; no new permit`)
    }
  } finally {
    writer.kill("SIGKILL")
    await writer.exited
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
