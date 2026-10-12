import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit } from "effect"
import { Database } from "../src/database/database"
import { LocalOperator } from "../src/im/local-operator"
import { RemoteTaskScope } from "../src/im/remote-task-scope"
import { IMTaskAuthorityFixture } from "./fixture/im-task-authority"
import { WorkAuthorityFixture } from "./fixture/work-authority"
import { EventInvestigationFixture } from "./fixture/event-investigation"
import { WorkAuthorityPolicy } from "../src/session/work-authority-policy"

const runtime = { instanceID: "receiver-instance", installationKeyHash: "1".repeat(64), credentialBinding: "2".repeat(64) }
const target = {
  id: "receiving-project",
  locationKey: "task-location",
  namespaceBindingHash: IMTaskAuthorityFixture.proof.namespaceBindingHash,
  target: { ...IMTaskAuthorityFixture.target,
    scope: { ...IMTaskAuthorityFixture.target.scope, workspaceID: IMTaskAuthorityFixture.target.location.directory } },
}
const verifier = await Bun.password.hash("private-scope-test", { algorithm: "argon2id", memoryCost: 4096, timeCost: 2 })
const initialize = Effect.gen(function* () {
  yield* IMTaskAuthorityFixture.initialize()
  const db = (yield* Database.Service).db
  yield* LocalOperator.enroll(db, { operationID: "scope-enroll", operatorID: IMTaskAuthorityFixture.principal.actorID,
    username: "scope-operator", credentialVerifier: verifier, policy: { version: 1, targets: [target] } })
  return { db, operator: yield* db.transaction((tx) => LocalOperator.requireCurrent(tx)) }
})
function code<A, E>(result: Exit.Exit<A, E>) {
  if (Exit.isSuccess(result)) return "success"
  const failure = Cause.squash(result.cause)
  return failure && typeof failure === "object" && "code" in failure ? failure.code : String(failure)
}
async function isolated<A, E>(effect: Effect.Effect<A, E, Database.Service>) {
  const root = await fs.mkdtemp("/private/tmp/dac-remote-task-scope-")
  try {
    return await Effect.runPromise(effect.pipe(Effect.provideService(LocalOperator.Runtime, runtime),
      Effect.provide(WorkAuthorityFixture.database(path.join(root, "authority.sqlite"))), Effect.scoped))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

test("remote target resolution reads the registered receiver scope with zero execution or writes", () => isolated(
  Effect.gen(function* () {
    const ready = yield* initialize
    const before = yield* ready.db.all("SELECT total_changes() changes")
    const resolved = yield* ready.db.transaction((tx) => RemoteTaskScope.resolve(tx, { targetID: target.id,
      directory: target.target.location.directory, expectedOperatorRevision: 1, expectedPolicyRevision: 1 })).pipe(
      Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(ready.operator)))
    expect(resolved.target).toEqual(target.target)
    expect(resolved.principal).toEqual(LocalOperator.principal(ready.operator))
    expect(resolved).toMatchObject({ credentialGeneration: 1, policyRevision: 1, locationKey: target.locationKey,
      namespaceBindingHash: target.namespaceBindingHash, targetHash: LocalOperator.hash(target.target) })
    expect(yield* ready.db.all("SELECT total_changes() changes")).toEqual(before)
    expect(yield* ready.db.all(`SELECT (SELECT count(*) FROM session) sessions,
      (SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM work_execution) work,
      (SELECT count(*) FROM session_provider_attempt) providers`)).toEqual([{ sessions: 0, inputs: 0, work: 0, providers: 0 }])
  }),
))

test("remote target IDs and project parameters only narrow the authenticated receiving scope", () => isolated(
  Effect.gen(function* () {
    const ready = yield* initialize
    const denied = [
      { targetID: "unregistered-project" },
      { targetID: target.id, directory: "/tmp/sender-selected-project" },
      { targetID: target.id, expectedOperatorRevision: 2 },
      { targetID: target.id, expectedPolicyRevision: 2 },
    ]
    const results = yield* Effect.forEach(denied, (input) => ready.db.transaction((tx) => RemoteTaskScope.resolve(tx, input)).pipe(
      Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(ready.operator)), Effect.exit))
    expect(results.map(code)).toEqual(["LOCAL_TASK_SCOPE_DENIED", "LOCAL_TASK_SCOPE_DENIED",
      "LOCAL_OPERATOR_REVISION_CONFLICT", "LOCAL_OPERATOR_REVISION_CONFLICT"])
    expect((yield* ready.db.transaction((tx) => RemoteTaskScope.targets(tx, { directory: "/tmp/unapproved" })).pipe(
      Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(ready.operator)))).targets).toEqual([])
  }),
))

test("missing or stale authenticated operator proof cannot resolve a remote target", () => isolated(
  Effect.gen(function* () {
    const ready = yield* initialize
    expect(code(yield* ready.db.transaction((tx) => RemoteTaskScope.resolve(tx, { targetID: target.id })).pipe(Effect.exit)))
      .toBe("LOCAL_OPERATOR_AUTH_REQUIRED")
    const stale = LocalOperator.mutationWitness(ready.operator)
    yield* ready.db.transaction((tx) => LocalOperator.updatePolicyInTransaction(tx, { expectedRevision: 1,
      policy: { version: 1, targets: [target] }, now: Date.now() })).pipe(Effect.provideService(LocalOperator.Mutation, stale))
    expect(code(yield* ready.db.transaction((tx) => RemoteTaskScope.resolve(tx, { targetID: target.id })).pipe(
      Effect.provideService(LocalOperator.Mutation, stale), Effect.exit))).toBe("LOCAL_OPERATOR_AUTH_REQUIRED")
    const current = yield* ready.db.transaction((tx) => LocalOperator.requireCurrent(tx))
    expect((yield* ready.db.transaction((tx) => RemoteTaskScope.resolve(tx, { targetID: target.id,
      expectedOperatorRevision: 2, expectedPolicyRevision: 2 })).pipe(
      Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(current)))).principal.revision).toBe(2)
  }),
))

test("registered DeepSeek context-bound target is visible only at its exact directory with current operator proof", () => isolated(
  Effect.gen(function* () {
    yield* IMTaskAuthorityFixture.initialize()
    const db = (yield* Database.Service).db
    const candidate = EventInvestigationFixture.binding()
    const project = { ...target, target: { ...target.target, version: 2 as const,
      profile: { id: WorkAuthorityPolicy.DEEPSEEK_PROJECT_PROFILE.id, version: 1,
        hash: WorkAuthorityPolicy.DEEPSEEK_PROJECT_PROFILE_HASH },
      provider: { ...target.target.provider, providerID: "deepseek", modelID: "deepseek-flash",
        protocol: "openai-responses" as const, endpoint: "https://api.deepseek.com/responses" },
      budget: { ...WorkAuthorityPolicy.DEEPSEEK_PROJECT_PROFILE.budget },
      projectScope: { ...candidate.projectScope, locationKey: target.locationKey,
        namespaceBindingHash: target.namespaceBindingHash, canonicalRoot: target.target.location.directory },
      contextPolicy: candidate.contextPolicy, toolPolicy: candidate.toolPolicy, childPolicy: "deny_all" as const,
    } }
    yield* LocalOperator.enroll(db, { operationID: "deepseek-scope-enroll", operatorID: IMTaskAuthorityFixture.principal.actorID,
      username: "scope-operator", credentialVerifier: verifier, policy: { version: 2, targets: [project] } })
    const current = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
    const before = yield* db.all("SELECT total_changes() changes")
    const catalog = yield* db.transaction((tx) => RemoteTaskScope.targets(tx, {
      directory: project.target.location.directory,
    })).pipe(Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(current)))
    expect(catalog.targets).toEqual([project])
    expect(catalog.principal).toEqual(LocalOperator.principal(current))
    expect((yield* db.transaction((tx) => RemoteTaskScope.targets(tx, { directory: "/tmp/unapproved" })).pipe(
      Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(current)))).targets).toEqual([])
    expect(code(yield* db.transaction((tx) => RemoteTaskScope.targets(tx, {
      directory: project.target.location.directory,
    })).pipe(Effect.exit))).toBe("LOCAL_OPERATOR_AUTH_REQUIRED")
    expect(yield* db.all("SELECT total_changes() changes")).toEqual(before)
    expect(yield* db.all(`SELECT (SELECT count(*) FROM session) sessions,
      (SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM work_execution) work,
      (SELECT count(*) FROM session_provider_attempt) providers`)).toEqual([{ sessions: 0, inputs: 0, work: 0, providers: 0 }])
  }),
))
