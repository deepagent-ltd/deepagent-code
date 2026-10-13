import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq, sql } from "drizzle-orm"
import { Cause, Effect, Exit, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { IMTaskAuthority } from "@deepagent-code/core/im/task-authority"
import { IMTaskAuthoritySchema } from "@deepagent-code/core/im/task-authority.schema"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { LocalTaskAuth } from "@deepagent-code/core/im/local-task-auth"
import { LocalTaskPolicy } from "@deepagent-code/core/im/local-task-policy"
import { WorkAuthority } from "@deepagent-code/core/session/work-authority"
import { WorkAuthorityFixture } from "../../../core/test/fixture/work-authority"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { IMTaskSession } from "@/im/task-session"

const runtime = { instanceID: "task-session-instance", installationKeyHash: "1".repeat(64), credentialBinding: "2".repeat(64) }
const route: WorkAuthority.Verification = {
  // This fixture proves the read boundary, not an external provider contract or execution.
  authorizeSource: (tx, binding) => IMTaskAuthority.authorizeWorkSource(tx, binding),
  resolveRoute: (_tx, binding) => Effect.succeed({ evidenceID: binding.provider.evidenceID,
    evidenceHash: binding.provider.evidenceHash, configurationHash: binding.provider.configurationHash }),
}
const password = await Bun.password.hash("private-read-only-fixture", { algorithm: "argon2id", memoryCost: 4096, timeCost: 2 })
function run<A, E>(filename: string, effect: Effect.Effect<A, E, Database.Service | IMRepository>) {
  return Effect.runPromise(effect.pipe(
    Effect.provideService(WorkAuthority.Verifier, route),
    Effect.provide(LocalTaskAuth.layer),
    Effect.provideService(LocalOperator.Runtime, runtime),
    Effect.provide(Layer.provideMerge(IMRepositoryLive, WorkAuthorityFixture.database(filename))),
    Effect.scoped,
  ))
}
function code<A, E>(result: Exit.Exit<A, E>) {
  if (Exit.isSuccess(result)) return "success"
  const error = Cause.squash(result.cause)
  return error instanceof IMTaskAuthoritySchema.Error ? error.code : String(error)
}
const census = Effect.gen(function* () {
  return yield* (yield* Database.Service).db.all(sql`SELECT
    (SELECT count(*) FROM session) sessions, (SELECT count(*) FROM session_input) inputs,
    (SELECT count(*) FROM session_provider_attempt) attempts, (SELECT count(*) FROM session_v2_provider_turn_receipt) providers,
    (SELECT count(*) FROM session_v2_tool_effect) effects, (SELECT count(*) FROM im_reply_outbox) replies`)
})

async function isolated(body: (filename: string, directory: string) => Promise<void>) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "dac-task-session-")))
  try {
    await run(join(directory, "authority.sqlite"), WorkAuthorityFixture.initialize())
    await body(join(directory, "authority.sqlite"), directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const seed = (directory: string) => Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const repo = yield* IMRepository
  const now = Date.now()
  const target = {
    scope: { actorID: "task-session-operator", workspaceID: directory, securityNamespaceID: "task-session-namespace", projectScopeKey: "task-session-project" },
    location: { directory }, agentID: "build", profile: WorkAuthorityFixture.binding().profile,
    provider: WorkAuthorityFixture.binding().provider, budget: WorkAuthorityFixture.binding().budget, durationMs: 60000,
  }
  yield* db.run(sql`INSERT INTO context_security_namespace(id,kind,binding_hash,created_at)
    VALUES('task-session-namespace','implicit_local',${"b".repeat(64)},${now})`)
  yield* db.run(sql`INSERT INTO context_project_scope_identity(security_namespace_id,project_scope_key,project_kind,project_identity_hash,observed_project_id,created_at)
    VALUES('task-session-namespace','task-session-project','registered_root','task-session-root','project-task-session',${now})`)
  yield* db.run(sql`INSERT INTO context_location_identity(security_namespace_id,location_key,project_scope_key,canonical_root,observed_project_id,created_at)
    VALUES('task-session-namespace','task-session-location','task-session-project',${directory},'project-task-session',${now})`)
  yield* LocalOperator.enroll(db, { operationID: "enroll", operatorID: target.scope.actorID, username: "fixture-operator",
    credentialVerifier: password, policy: { version: 1, targets: [{ id: "review", locationKey: "task-session-location",
      namespaceBindingHash: "b".repeat(64), target }] } })
  const operator = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
  const witness = LocalOperator.mutationWitness(operator)
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provideService(LocalOperator.Mutation, witness))
  const group = yield* repo.createGroup({ workspaceID: directory, createdBy: "server", type: "project", name: "Read original live Session" })
  yield* provide(LocalTaskPolicy.enable(db, { groupID: group.id, operationID: "enable", targetID: "review", expectedRevision: 0 }))
  const message = yield* provide(repo.createMessage({ groupID: group.id, senderID: "server", senderType: "user",
    type: "text", content: WorkAuthorityFixture.TEXT, clientRequestID: "source" }))
  const request = yield* provide(IMTaskAuthority.propose(db, { clientRequestID: "propose", messageID: message.id,
    auditedText: message.content, target }))
  const grant = yield* provide(IMTaskAuthority.accept(db, { requestID: request.request_id, operationID: "accept", expectedRevision: 1 }))
  yield* provide(WorkAuthority.reserve(db, { binding: grant.binding }))
  // Explicit storage specimen for a ready, not-yet-run Work. No provider receipts, terminal
  // answers, execution owners, or claims are fabricated; actual admission is the UI integration gate.
  yield* db.run(sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated)
    VALUES('project-task-session',${directory},'[]',${now},${now})`)
  yield* db.run(sql`INSERT INTO session(id,project_id,slug,directory,title,version,v2_authority,agent,model,time_created,time_updated)
    VALUES(${grant.session_id},'project-task-session',${grant.session_id},${directory},'Ready Work','2',1,${target.agentID},
      ${JSON.stringify({ id: target.provider.modelID, providerID: target.provider.providerID })},${now},${now})`)
  yield* db.transaction((tx) => Effect.gen(function* () {
    yield* tx.run(sql`INSERT INTO session_input(id,session_id,prompt,delivery,admitted_seq,time_created)
      VALUES(${grant.input_id},${grant.session_id},${JSON.stringify({ text: message.content })},'queue',1,${now})`)
    yield* provide(WorkAuthority.bindInputInTransaction(tx, { workID: grant.work_id, sessionID: grant.session_id,
      inputID: grant.input_id, promptHash: grant.binding.auditedText.hash, admittedSeq: 1, expectedRevision: 1 }))
  }))
  return { witness, requestID: request.request_id, grant, message, group,
    input: { requestID: request.request_id, directory, workspaceID: directory, userID: "server" } }
})

test("current original Session pointer supports pre-promotion and cold reads without execution or writes", () => isolated(async (filename, directory) => {
  const original = await run(filename, Effect.gen(function* () {
    const value = yield* seed(directory)
    const port = yield* IMTaskSession.make
    const before = yield* census
    const pointer = yield* port.read(value.input).pipe(Effect.provideService(LocalOperator.Mutation, value.witness))
    expect(pointer).toMatchObject({ version: 1, requestID: value.requestID,
      source: { messageID: value.message.id, groupID: value.group.id },
      placement: { projectID: "project-task-session", workspaceID: null, sessionID: value.grant.session_id },
      attempt: { workID: value.grant.work_id, inputID: value.grant.input_id } })
    expect(pointer.expiresAt).toBe(value.grant.binding.deadline)
    expect(yield* census).toEqual(before)
    expect(before).toEqual([{ sessions: 1, inputs: 1, attempts: 0, providers: 0, effects: 0, replies: 0 }])
    expect((yield* (yield* Database.Service).db.all("PRAGMA foreign_key_check"))).toEqual([])
    return { pointer, input: value.input, witness: value.witness }
  }))
  await run(filename, Effect.gen(function* () {
    const port = yield* IMTaskSession.make
    expect(yield* port.read(original.input).pipe(Effect.provideService(LocalOperator.Mutation, original.witness))).toEqual(original.pointer)
    expect(yield* census).toEqual([{ sessions: 1, inputs: 1, attempts: 0, providers: 0, effects: 0, replies: 0 }])
  }))
}))

test("source/member/input/placement and grant changes cannot turn management facts into a Session pointer", () => isolated(async (filename, directory) => {
  await run(filename, Effect.gen(function* () {
    const value = yield* seed(directory)
    const db = (yield* Database.Service).db
    const port = yield* IMTaskSession.make
    const read = (input = value.input) => port.read(input).pipe(Effect.provideService(LocalOperator.Mutation, value.witness), Effect.exit)
    expect(code(yield* read({ ...value.input, directory: directory + "/foreign" }))).toBe("IM_TASK_FORBIDDEN")
    expect(code(yield* port.read(value.input).pipe(Effect.exit))).toBe("IM_TASK_FORBIDDEN")
    expect(code(yield* read({ ...value.input, userID: "foreign-recipient" }))).toBe("IM_TASK_IDENTITY_CONFLICT")
    expect(code(yield* read({ ...value.input, workspaceID: "foreign-workspace" }))).toBe("IM_TASK_IDENTITY_CONFLICT")
    yield* db.run(sql`UPDATE session_input SET prompt=${JSON.stringify({ text: WorkAuthorityFixture.TEXT, metadata: { injected: true } })} WHERE id=${value.grant.input_id}`)
    expect(code(yield* read())).toBe("IM_TASK_IDENTITY_CONFLICT")
    yield* db.run(sql`UPDATE session_input SET prompt=${JSON.stringify({ text: WorkAuthorityFixture.TEXT })} WHERE id=${value.grant.input_id}`)
    yield* db.update(SessionTable).set({ directory: directory + "/foreign" }).where(eq(SessionTable.id, SessionSchema.ID.make(value.grant.session_id))).run()
    expect(code(yield* read())).toBe("IM_TASK_IDENTITY_CONFLICT")
    yield* db.update(SessionTable).set({ directory }).where(eq(SessionTable.id, SessionSchema.ID.make(value.grant.session_id))).run()
    yield* db.run(sql`UPDATE im_messages SET content='changed source' WHERE id=${value.message.id}`)
    expect(code(yield* read())).toBe("IM_TASK_SOURCE_UNAVAILABLE")
    yield* db.run(sql`UPDATE im_messages SET content=${WorkAuthorityFixture.TEXT} WHERE id=${value.message.id}`)
    yield* db.run(sql`UPDATE context_security_namespace SET retired_at=${Date.now()} WHERE id='task-session-namespace'`)
    expect(code(yield* read())).toBe("IM_TASK_FORBIDDEN")
    yield* db.run("UPDATE context_security_namespace SET retired_at=NULL WHERE id='task-session-namespace'")
    const before = yield* census
    yield* IMTaskAuthority.revoke(db, { grantID: value.grant.grant_id, operationID: "revoke", expectedRevision: 1 })
      .pipe(Effect.provideService(LocalOperator.Mutation, value.witness))
    expect(code(yield* read())).toBe("IM_TASK_REVOKED")
    expect(yield* census).toEqual(before)
  }))
}))
