import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { sql } from "drizzle-orm"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"
import { IMTaskAuthority } from "../src/im/task-authority"
import { IMTaskAuthoritySchema } from "../src/im/task-authority.schema"
import { WorkAuthority } from "../src/session/work-authority"
import { WorkAuthoritySchema } from "../src/session/work-authority.schema"
import { IMTaskAuthorityFixture } from "./fixture/im-task-authority"
import { WorkAuthorityFixture } from "./fixture/work-authority"

function run<A, E>(filename: string, effect: Effect.Effect<A, E, Database.Service>) {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(IMTaskAuthorityFixture.authority),
      Effect.provide(WorkAuthorityFixture.database(filename)),
      Effect.scoped,
    ),
  )
}
function code<A, E>(exit: Exit.Exit<A, E>) {
  if (Exit.isSuccess(exit)) return "success"
  const error = Cause.squash(exit.cause)
  return error instanceof IMTaskAuthoritySchema.Error || error instanceof WorkAuthoritySchema.Error
    ? error.code
    : String(error)
}
async function isolated(body: (filename: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "im-task-authority-"))
  try {
    const filename = join(root, "task.sqlite")
    await run(filename, IMTaskAuthorityFixture.initialize())
    await body(filename)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
const acceptInput = (request: IMTaskAuthority.Request) => ({
  requestID: request.request_id,
  operationID: "accept-one",
  expectedRevision: 1,
  now: Date.now(),
})
const counts = Effect.gen(function* () {
  return yield* (yield* Database.Service).db.all<{ work: number; input: number; session: number; provider: number }>(
    "SELECT (SELECT count(*) FROM work_execution) work, (SELECT count(*) FROM session_input) input, (SELECT count(*) FROM session) session, (SELECT count(*) FROM session_provider_attempt) provider",
  )
})

test("member, @Agent intent and server owner cannot substitute for authenticated internal authority", () =>
  isolated(async (filename) => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* IMTaskAuthority.propose((yield* Database.Service).db, IMTaskAuthorityFixture.proposal).pipe(
          Effect.exit,
        )
      }).pipe(Effect.provide(WorkAuthorityFixture.database(filename)), Effect.scoped),
    )
    expect(code(result)).toBe("IM_TASK_AUTHORITY_UNAVAILABLE")
    await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const request = yield* IMTaskAuthority.propose(db, IMTaskAuthorityFixture.proposal)
        yield* db.run("UPDATE test_task_operator SET authenticated = 0")
        expect(code(yield* IMTaskAuthority.accept(db, acceptInput(request)).pipe(Effect.exit))).toBe(
          "IM_TASK_FORBIDDEN",
        )
        expect((yield* db.all<{ count: number }>("SELECT count(*) count FROM im_task_grant"))[0]?.count).toBe(0)
        expect(yield* counts).toEqual([{ work: 0, input: 0, session: 0, provider: 0 }])
      }),
    )
  }))

test("proposal exact retry is immutable and never creates execution state", () =>
  isolated(async (filename) => {
    await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const request = yield* IMTaskAuthority.propose(db, IMTaskAuthorityFixture.proposal)
        const retry = yield* IMTaskAuthority.propose(db, {
          ...IMTaskAuthorityFixture.proposal,
          now: IMTaskAuthorityFixture.NOW + 1_000,
        })
        expect(retry).toEqual(request)
        expect(request.expires_at - request.created_at).toBe(86_400_000)
        expect(
          code(
            yield* IMTaskAuthority.propose(db, { ...IMTaskAuthorityFixture.proposal, auditedText: "changed" }).pipe(
              Effect.exit,
            ),
          ),
        ).toBe("IM_TASK_IDENTITY_CONFLICT")
        expect(yield* counts).toEqual([{ work: 0, input: 0, session: 0, provider: 0 }])
      }),
    )
  }))

test.each([
  "history",
  "unverified",
  "agent",
  "deleted",
  "receiver",
  "namespace",
  "generation",
  "expired",
  "target",
  "raw-text",
  "member",
])("%s source change cannot mint a grant", (change) =>
  isolated(async (filename) => {
    await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const request = yield* IMTaskAuthority.propose(db, IMTaskAuthorityFixture.proposal)
        if (change === "history" || change === "unverified")
          yield* db.run(
            sql`UPDATE test_task_source_proof SET proof = ${JSON.stringify({ ...IMTaskAuthorityFixture.proof, origin: change })}`,
          )
        if (change === "agent") yield* db.run("UPDATE im_messages SET sender_type = 'agent'")
        if (change === "deleted") yield* db.run("UPDATE im_messages SET deleted_at = 1")
        if (change === "receiver")
          yield* db.run(
            sql`UPDATE test_task_source_proof SET proof = ${JSON.stringify({ ...IMTaskAuthorityFixture.proof, receiverID: "different-receiver" })}`,
          )
        if (change === "namespace") yield* db.run("UPDATE context_security_namespace SET retired_at = 1")
        if (change === "generation")
          yield* db.run(
            sql`UPDATE test_task_source_proof SET proof = ${JSON.stringify({ ...IMTaskAuthorityFixture.proof, generation: 2 })}`,
          )
        if (change === "expired")
          yield* db.run(
            sql`UPDATE test_task_source_proof SET proof = ${JSON.stringify({ ...IMTaskAuthorityFixture.proof, expiresAt: IMTaskAuthorityFixture.NOW - 1 })}`,
          )
        if (change === "target") yield* db.run("UPDATE context_location_identity SET retired_at = 1")
        if (change === "member")
          yield* db.run(sql`DELETE FROM im_members WHERE member_id = ${IMTaskAuthorityFixture.proof.senderID}`)
        if (change === "raw-text") yield* db.run("UPDATE im_messages SET content = 'changed after review'")
        expect(Exit.isFailure(yield* IMTaskAuthority.accept(db, acceptInput(request)).pipe(Effect.exit))).toBe(true)
        expect((yield* db.all<{ count: number }>("SELECT count(*) count FROM im_task_grant"))[0]?.count).toBe(0)
        expect(yield* counts).toEqual([{ work: 0, input: 0, session: 0, provider: 0 }])
      }),
    )
  }),
)

test("accepted grant reopens with one stable attempt and exact source binding, while route remains independently unavailable", () =>
  isolated(async (filename) => {
    const grant = await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        return yield* IMTaskAuthority.accept(
          db,
          acceptInput(yield* IMTaskAuthority.propose(db, IMTaskAuthorityFixture.proposal)),
        )
      }),
    )
    await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const request = yield* IMTaskAuthority.readRequest(db, grant.request_id)
        const retry = yield* IMTaskAuthority.accept(db, acceptInput(request))
        expect(retry).toEqual(grant)
        expect(request.state).toBe("accepted")
        expect(request.revision).toBe(2)
        expect(yield* db.transaction((tx) => IMTaskAuthority.authorizeWorkSource(tx, grant.binding))).toEqual({
          authorityID: grant.grant_id,
          revision: 1,
          recordHash: grant.record_hash,
        })
        expect(
          code(
            yield* db
              .transaction((tx) =>
                IMTaskAuthority.authorizeWorkSource(tx, {
                  ...grant.binding,
                  budget: { ...grant.binding.budget, maxTotalTokens: 7_999 },
                }),
              )
              .pipe(Effect.exit),
          ),
        ).toBe("WORK_REVOKED")
        const unavailable = yield* WorkAuthority.reserve(db, { binding: grant.binding }).pipe(
          Effect.provide(
            Layer.succeed(WorkAuthority.Verifier, {
              authorizeSource: IMTaskAuthority.authorizeWorkSource,
              resolveRoute: () =>
                Effect.fail(
                  new WorkAuthoritySchema.Error({
                    code: "PROFILE_UNAVAILABLE",
                    message: "No trusted runtime route resolver",
                  }),
                ),
            }),
          ),
          Effect.exit,
        )
        expect(code(unavailable)).toBe("PROFILE_UNAVAILABLE")
        expect(code(yield* IMTaskAuthority.accept(db, { ...acceptInput(request), ordinal: 2 }).pipe(Effect.exit))).toBe(
          "IM_TASK_UNSUPPORTED_ATTEMPT",
        )
        expect(yield* counts).toEqual([{ work: 0, input: 0, session: 0, provider: 0 }])
      }),
    )
  }))

test("two real file connections accept once; explicit revoke CAS survives restart and rejects source reuse", () =>
  isolated(async (filename) => {
    const request = await run(
      filename,
      Effect.gen(function* () {
        return yield* IMTaskAuthority.propose((yield* Database.Service).db, IMTaskAuthorityFixture.proposal)
      }),
    )
    const accepted = await Promise.all(
      ["a", "b"].map((operationID) =>
        run(
          filename,
          Effect.gen(function* () {
            return yield* IMTaskAuthority.accept((yield* Database.Service).db, {
              ...acceptInput(request),
              operationID,
            }).pipe(Effect.exit)
          }),
        ),
      ),
    )
    expect(accepted.map(code).sort()).toEqual(["IM_TASK_IDENTITY_CONFLICT", "success"])
    const winner = accepted.find(Exit.isSuccess)
    expect(winner).toBeDefined()
    if (!winner || !Exit.isSuccess(winner)) throw new Error("No accepted grant")
    const grant = winner.value
    await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        expect(
          code(
            yield* IMTaskAuthority.revoke(db, {
              grantID: grant.grant_id,
              operationID: "revoke-one",
              expectedRevision: 2,
            }).pipe(Effect.exit),
          ),
        ).toBe("IM_TASK_REVISION_CONFLICT")
        const revoked = yield* IMTaskAuthority.revoke(db, {
          grantID: grant.grant_id,
          operationID: "revoke-one",
          expectedRevision: 1,
        })
        expect(revoked.revision).toBe(2)
      }),
    )
    await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        expect(
          (yield* IMTaskAuthority.revoke(db, {
            grantID: grant.grant_id,
            operationID: "revoke-one",
            expectedRevision: 1,
          })).state,
        ).toBe("revoked")
        expect(
          code(yield* db.transaction((tx) => IMTaskAuthority.authorizeWorkSource(tx, grant.binding)).pipe(Effect.exit)),
        ).toBe("WORK_REVOKED")
        expect(
          code(
            yield* IMTaskAuthority.accept(db, { ...acceptInput(request), operationID: grant.accept_request_id }).pipe(
              Effect.exit,
            ),
          ),
        ).toBe("IM_TASK_REVOKED")
        expect((yield* db.all<{ count: number }>("SELECT count(*) count FROM im_task_grant"))[0]?.count).toBe(1)
        expect(yield* counts).toEqual([{ work: 0, input: 0, session: 0, provider: 0 }])
      }),
    )
  }))

test("grant ID is not bearer authority and current operator or target-policy changes fence its source verifier", () =>
  isolated(async (filename) => {
    await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const request = yield* IMTaskAuthority.propose(db, IMTaskAuthorityFixture.proposal)
        const grant = yield* IMTaskAuthority.accept(db, acceptInput(request))
        yield* db.run(
          sql`UPDATE test_task_operator SET principal = ${JSON.stringify({ ...IMTaskAuthorityFixture.principal, actorID: "other-operator" })}`,
        )
        expect(
          code(
            yield* IMTaskAuthority.revoke(db, {
              grantID: grant.grant_id,
              operationID: "other-revoke",
              expectedRevision: 1,
            }).pipe(Effect.exit),
          ),
        ).toBe("IM_TASK_NOT_VISIBLE")
        yield* db.run(
          sql`UPDATE test_task_operator SET principal = ${JSON.stringify(IMTaskAuthorityFixture.principal)}`,
        )
        yield* db.run(sql`UPDATE test_task_target SET record_hash = ${"f".repeat(64)}`)
        expect(
          code(yield* db.transaction((tx) => IMTaskAuthority.authorizeWorkSource(tx, grant.binding)).pipe(Effect.exit)),
        ).toBe("WORK_REVOKED")
        expect(
          (yield* db.all<{ state: string; revision: number }>("SELECT state, revision FROM im_task_grant"))[0],
        ).toEqual({ state: "active", revision: 1 })
      }),
    )
  }))

test("an unknown existing Work attempt cannot be accepted again or replaced by a second input", () =>
  isolated(async (filename) => {
    await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const request = yield* IMTaskAuthority.propose(db, IMTaskAuthorityFixture.proposal)
        const grant = yield* IMTaskAuthority.accept(db, acceptInput(request))
        // Controlled route proof is a store fixture only. No production route or provider is used.
        yield* WorkAuthority.reserve(db, { binding: grant.binding }).pipe(
          Effect.provide(
            Layer.succeed(WorkAuthority.Verifier, {
              authorizeSource: IMTaskAuthority.authorizeWorkSource,
              resolveRoute: () =>
                Effect.succeed({
                  evidenceID: grant.binding.provider.evidenceID,
                  evidenceHash: grant.binding.provider.evidenceHash,
                  configurationHash: grant.binding.provider.configurationHash,
                }),
            }),
          ),
        )
        // Inject a previously quarantined Work fact to exercise business-control behavior; the
        // separate WorkAuthority process suite proves real in-flight escrow survives SIGKILL.
        yield* db.run("UPDATE work_execution SET outcome = 'unknown'")
        const before = yield* db.all("SELECT * FROM work_execution")
        expect(code(yield* IMTaskAuthority.accept(db, acceptInput(request)).pipe(Effect.exit))).toBe(
          "IM_TASK_RESULT_UNKNOWN",
        )
        expect(code(yield* IMTaskAuthority.accept(db, { ...acceptInput(request), ordinal: 2 }).pipe(Effect.exit))).toBe(
          "IM_TASK_UNSUPPORTED_ATTEMPT",
        )
        yield* IMTaskAuthority.revoke(db, {
          grantID: grant.grant_id,
          operationID: "revoke-unknown",
          expectedRevision: 1,
        })
        expect(yield* db.all("SELECT * FROM work_execution")).toEqual(before)
        expect(yield* counts).toEqual([{ work: 1, input: 0, session: 0, provider: 0 }])
      }),
    )
  }))

test("full fresh migrations reapply without changing committed request and grant identities", () =>
  isolated(async (filename) => {
    await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const request = yield* IMTaskAuthority.propose(db, IMTaskAuthorityFixture.proposal)
        const grant = yield* IMTaskAuthority.accept(db, acceptInput(request))
        const tables = yield* db.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('im_task_source','im_task_request','im_task_grant') ORDER BY name",
        )
        expect(tables.map((row) => row.name)).toEqual(["im_task_grant", "im_task_request", "im_task_source"])
        const before = yield* db.all("SELECT * FROM migration ORDER BY id")
        yield* DatabaseMigration.applyOnly(db, migrations)
        expect(yield* db.all("SELECT * FROM migration ORDER BY id")).toEqual(before)
        expect(yield* IMTaskAuthority.accept(db, acceptInput(request))).toEqual(grant)
        expect(yield* counts).toEqual([{ work: 0, input: 0, session: 0, provider: 0 }])
      }),
    )
  }))

test.each([
  "UPDATE im_task_request SET state = 'proposed'",
  "UPDATE im_task_request SET revision = revision + 1",
  "UPDATE im_task_grant SET instance_id = 'another-instance'",
  "UPDATE im_task_grant SET actor_id = 'another-operator'",
])("stored grant mirrors must agree with its accepted request: %s", (mutation) =>
  isolated(async (filename) => {
    await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const request = yield* IMTaskAuthority.propose(db, IMTaskAuthorityFixture.proposal)
        const grant = yield* IMTaskAuthority.accept(db, acceptInput(request))
        yield* db.run(mutation)
        expect(
          code(yield* db.transaction((tx) => IMTaskAuthority.authorizeWorkSource(tx, grant.binding)).pipe(Effect.exit)),
        ).toBe("WORK_REVOKED")
        expect(yield* counts).toEqual([{ work: 0, input: 0, session: 0, provider: 0 }])
      }),
    )
  }),
)

test("production accept boundary rolls grant/request back with route or Work failure and reserves one cold-retry identity", () =>
  isolated(async (filename) => {
    const request = await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        return yield* IMTaskAuthority.propose(db, IMTaskAuthorityFixture.proposal)
      }),
    )
    const reserve = Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const route = yield* WorkAuthority.Verifier
      return yield* IMTaskAuthority.acceptAndReserve(db, acceptInput(request)).pipe(
        Effect.provideService(WorkAuthority.Verifier, {
          authorizeSource: IMTaskAuthority.authorizeWorkSource,
          resolveRoute: route.resolveRoute,
        }),
      )
    }).pipe(Effect.provide(WorkAuthorityFixture.verifier))
    await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* db.run("UPDATE test_work_route SET enabled=0")
        expect(code(yield* reserve.pipe(Effect.exit))).toBe("PROFILE_UNAVAILABLE")
        expect((yield* IMTaskAuthority.readRequest(db, request.request_id)).state).toBe("proposed")
        expect(yield* db.all("SELECT grant_id FROM im_task_grant")).toEqual([])
        expect(yield* counts).toEqual([{ work: 0, input: 0, session: 0, provider: 0 }])
        yield* db.run("UPDATE test_work_route SET enabled=1")
        yield* db.run(
          "CREATE TRIGGER reject_task_work BEFORE INSERT ON work_execution BEGIN SELECT RAISE(ABORT,'controlled Work failure'); END",
        )
        expect(Exit.isFailure(yield* reserve.pipe(Effect.exit))).toBe(true)
        expect((yield* IMTaskAuthority.readRequest(db, request.request_id)).state).toBe("proposed")
        expect(yield* db.all("SELECT grant_id FROM im_task_grant")).toEqual([])
        yield* db.run("DROP TRIGGER reject_task_work")
      }),
    )
    const accepted = await run(filename, reserve)
    expect(accepted.work.admission_state).toBe("reserved")
    await run(
      filename,
      Effect.gen(function* () {
        expect(yield* reserve).toEqual(accepted)
        const db = (yield* Database.Service).db
        expect(yield* counts).toEqual([{ work: 1, input: 0, session: 0, provider: 0 }])
        expect((yield* IMTaskAuthority.readAdmission(db, request.request_id)).work?.work_id).toBe(accepted.work.work_id)
        expect(
          code(
            yield* IMTaskAuthority.acceptAndReserve(db, { ...acceptInput(request), operationID: "other" }).pipe(
              Effect.exit,
            ),
          ),
        ).toBe("IM_TASK_IDENTITY_CONFLICT")
      }),
    )
  }))
