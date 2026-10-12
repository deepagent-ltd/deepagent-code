import { expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { Database } from "../src/database/database"
import { KernelReceiverMapping } from "../src/im/kernel-receiver-mapping"
import { LocalOperator } from "../src/im/local-operator"
import { LocalOperatorSchema } from "../src/im/local-operator.schema"
import { IMTaskAuthorityFixture } from "./fixture/im-task-authority"
import { WorkAuthorityFixture } from "./fixture/work-authority"

const runtime = { instanceID: "mapping-instance", installationKeyHash: "1".repeat(64), credentialBinding: "2".repeat(64) }
const now = Date.now()
const receiver = {
  id: "receiver-one", targetID: "review", realmID: "https://kernel.example/", appkeyID: "public-app",
  orgID: 17, receiverID: "platform-receiver", localUserID: "server" as const,
  issuedAt: now, expiresAt: now + LocalOperatorSchema.KERNEL_RECEIVER_LIFETIME_MS,
}
const policy = {
  version: 1 as const,
  targets: [{ id: "review", locationKey: "task-location", namespaceBindingHash: IMTaskAuthorityFixture.proof.namespaceBindingHash,
    target: { ...IMTaskAuthorityFixture.target, scope: { ...IMTaskAuthorityFixture.target.scope, workspaceID: IMTaskAuthorityFixture.target.location.directory } } }],
  kernelReceivers: [receiver],
}
const request = { targetID: "review", workspaceID: policy.targets[0].target.location.directory, localUserID: "server",
  source: { realm: receiver.realmID, appkey: receiver.appkeyID, orgID: receiver.orgID, senderID: receiver.receiverID, credentialFingerprint: "3".repeat(64) }, now }
const enrollment = { operationID: "enroll", operatorID: IMTaskAuthorityFixture.principal.actorID, username: "fixture-operator",
  credentialVerifier: await Bun.password.hash("private-test", { algorithm: "argon2id", memoryCost: 4096, timeCost: 2 }), policy, now }
function code<A, E>(exit: Exit.Exit<A, E>) {
  if (Exit.isSuccess(exit)) return "success"
  const error = Cause.squash(exit.cause)
  return typeof error === "object" && error !== null && "code" in error ? error.code : String(error)
}
function run<A, E>(filename: string, effect: Effect.Effect<A, E, Database.Service>, binding = runtime) {
  return Effect.runPromise(effect.pipe(Effect.provideService(LocalOperator.Runtime, binding),
    Effect.provide(WorkAuthorityFixture.database(filename)), Effect.scoped))
}
async function isolated(body: (filename: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "dac-kernel-receiver-"))
  try {
    const filename = path.join(directory, "authority.sqlite")
    await run(filename, IMTaskAuthorityFixture.initialize())
    await body(filename)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
const noExecution = Effect.gen(function* () {
  expect(yield* (yield* Database.Service).db.all(`SELECT
    (SELECT count(*) FROM session) sessions, (SELECT count(*) FROM session_input) inputs,
    (SELECT count(*) FROM work_execution) works, (SELECT count(*) FROM session_provider_attempt) providers`))
    .toEqual([{ sessions: 0, inputs: 0, works: 0, providers: 0 }])
})

test("explicit receiver identity survives file reopen with a fixed expiry and never writes on read", () => isolated(async (filename) => {
  const receipt = await run(filename, Effect.gen(function* () {
    return yield* LocalOperator.enroll((yield* Database.Service).db, enrollment)
  }))
  const original = await run(filename, Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const before = yield* db.all("SELECT total_changes() value")
    const mapping = yield* db.transaction((tx) => KernelReceiverMapping.requireCurrent(tx, request))
    expect(mapping.mapping.expiresAt).toBe(receiver.expiresAt)
    expect(mapping.principal.instanceID).toBe(runtime.instanceID)
    expect(mapping.registered.target.scope.workspaceID).toBe(request.workspaceID)
    expect(mapping.revision).toBe(1)
    expect(yield* db.all("SELECT total_changes() value")).toEqual(before)
    yield* noExecution
    return mapping
  }))
  await run(filename, Effect.gen(function* () {
    const db = (yield* Database.Service).db
    expect(yield* db.transaction((tx) => KernelReceiverMapping.requireCurrent(tx, { ...request, now: now + 1000 }))).toEqual(original)
    const before = yield* db.all("SELECT total_changes() value")
    expect(code(yield* db.transaction((tx) => KernelReceiverMapping.requireCurrent(tx, { ...request, now: receiver.expiresAt })).pipe(Effect.exit)))
      .toBe("LOCAL_TASK_SOURCE_UNAVAILABLE")
    expect(yield* LocalOperator.enroll(db, { ...enrollment, now: receiver.expiresAt + 1 })).toEqual(receipt)
    expect((yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))).policy.kernelReceivers?.[0]?.expiresAt).toBe(receiver.expiresAt)
    expect(yield* db.all("SELECT total_changes() value")).toEqual(before)
    yield* noExecution
  }))
}))

test("requires the exact realm, app, org, receiver, local viewer and registered workspace", () => isolated(async (filename) => {
  await run(filename, Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* LocalOperator.enroll(db, enrollment)
    for (const changed of [
      { ...request, targetID: "foreign-target" }, { ...request, workspaceID: "/foreign" }, { ...request, localUserID: "another-viewer" },
      ...[{ realm: "https://other.example/" }, { appkey: "another-app" }, { orgID: 18 }, { orgID: null }, { senderID: "other-receiver" }]
        .map((source) => ({ ...request, source: { ...request.source, ...source } })),
    ]) expect(code(yield* db.transaction((tx) => KernelReceiverMapping.requireCurrent(tx, changed)).pipe(Effect.exit))).not.toBe("success")
    yield* noExecution
  }))
}))

test("rejects implicit, ambiguous, expired, future, excessive-lifetime and unregistered mappings without enrollment writes", () => isolated(async (filename) => {
  await run(filename, Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const before = yield* db.all("SELECT total_changes() value")
    for (const kernelReceivers of [
      [receiver, { ...receiver, id: "duplicate-scope" }], [receiver, receiver],
      [{ ...receiver, targetID: "unregistered" }], [{ ...receiver, issuedAt: now + 1, expiresAt: receiver.expiresAt + 1 }],
      [{ ...receiver, issuedAt: now - LocalOperatorSchema.KERNEL_RECEIVER_LIFETIME_MS, expiresAt: now }],
      [{ ...receiver, expiresAt: receiver.expiresAt + 1 }], [{ ...receiver, verified: true }],
    ]) expect(code(yield* LocalOperator.enroll(db, { ...enrollment, policy: { ...policy, kernelReceivers } }).pipe(Effect.exit))).not.toBe("success")
    expect(yield* db.all("SELECT total_changes() value")).toEqual(before)
    const legacy = { version: policy.version, targets: policy.targets }
    yield* LocalOperator.enroll(db, { ...enrollment, policy: legacy })
    expect(code(yield* db.transaction((tx) => KernelReceiverMapping.requireCurrent(tx, request)).pipe(Effect.exit))).toBe("LOCAL_TASK_SOURCE_UNAVAILABLE")
    yield* noExecution
  }))
}))

test("rotation changes mapping authority without renewing its source lifetime; old config cannot adopt it", () => isolated(async (filename) => {
  const previous = await run(filename, Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* LocalOperator.enroll(db, enrollment)
    const current = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
    const mapping = yield* db.transaction((tx) => KernelReceiverMapping.requireCurrent(tx, request))
    yield* LocalOperator.rotate(db, { operationID: "rotate", expectedRevision: current.revision,
      username: current.username, credentialVerifier: enrollment.credentialVerifier, now: now + 2000 })
      .pipe(Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(current)))
    const next = yield* db.transaction((tx) => KernelReceiverMapping.requireCurrent(tx, { ...request, now: now + 2000 }))
    expect(next.mapping).toEqual(mapping.mapping)
    expect(next.recordHash).not.toBe(mapping.recordHash)
    expect(next.revision).toBe(2)
    expect(next.credentialGeneration).toBe(2)
    yield* noExecution
    return next
  }))
  expect(code(await run(filename, Effect.gen(function* () {
    return yield* (yield* Database.Service).db.transaction((tx) => KernelReceiverMapping.requireCurrent(tx, request)).pipe(Effect.exit)
  }), { ...runtime, credentialBinding: "f".repeat(64) }))).toBe("LOCAL_OPERATOR_CONFIG_MISMATCH")
  expect(previous.mapping.expiresAt).toBe(receiver.expiresAt)
}))
