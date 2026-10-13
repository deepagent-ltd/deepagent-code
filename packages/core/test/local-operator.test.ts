import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Database } from "../src/database/database"
import { IMRepository, IMRepositoryLive } from "../src/im/repository"
import { LocalOperator } from "../src/im/local-operator"
import { LocalAuthorityFixture } from "./fixture/local-authority"
import { WorkAuthorityFixture } from "./fixture/work-authority"

const runtime = { instanceID: "local-instance", installationKeyHash: "1".repeat(64), credentialBinding: "2".repeat(64) }
const policy = {
  version: 1 as const,
  targets: [
    {
      id: "review-target",
      locationKey: "task-location",
      namespaceBindingHash: LocalAuthorityFixture.namespace.namespaceBindingHash,
      target: {
        ...LocalAuthorityFixture.target,
        scope: {
          ...LocalAuthorityFixture.target.scope,
          workspaceID: LocalAuthorityFixture.target.location.directory,
        },
      },
    },
  ],
}
const passwordVerifier = await Bun.password.hash("isolated-test-password", {
  algorithm: "argon2id",
  memoryCost: 4096,
  timeCost: 2,
})
const enrollment = {
  operationID: "enroll-one",
  operatorID: LocalAuthorityFixture.principal.actorID,
  username: "test-operator",
  credentialVerifier: passwordVerifier,
  policy,
}
function code<A, E>(value: Exit.Exit<A, E>) {
  if (Exit.isSuccess(value)) return "success"
  const error = Cause.squash(value.cause)
  return typeof error === "object" && error !== null && "code" in error ? error.code : String(error)
}
function run<A, E>(filename: string, effect: Effect.Effect<A, E, Database.Service | IMRepository>, binding = runtime) {
  const database = WorkAuthorityFixture.database(filename)
  return Effect.runPromise(
    effect.pipe(
      Effect.provideService(LocalOperator.Runtime, binding),
      Effect.provide(Layer.provideMerge(IMRepositoryLive, database)),
      Effect.scoped,
    ),
  )
}
async function isolated(body: (filename: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "local-operator-"))
  try {
    const filename = join(root, "operator.sqlite")
    await run(filename, LocalAuthorityFixture.initialize())
    await body(filename)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
const zeroExecution = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  expect(
    yield* db.all(
      "SELECT (SELECT count(*) FROM session) sessions,(SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM work_execution) work,(SELECT count(*) FROM session_provider_attempt) providers",
    ),
  ).toEqual([{ sessions: 0, inputs: 0, work: 0, providers: 0 }])
})

test("enrollment exact retry and config/key checks survive file reopening", () =>
  isolated(async (filename) => {
    const receipt = await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const first = yield* LocalOperator.enroll(db, enrollment)
        expect(yield* LocalOperator.enroll(db, enrollment)).toEqual(first)
        expect(code(yield* LocalOperator.enroll(db, { ...enrollment, username: "changed" }).pipe(Effect.exit))).toBe(
          "LOCAL_OPERATOR_CONFLICT",
        )
        expect(code(yield* db.transaction((tx) => LocalOperator.requireMutation(tx)).pipe(Effect.exit))).toBe(
          "LOCAL_OPERATOR_AUTH_REQUIRED",
        )
        yield* zeroExecution
        return first
      }),
    )
    await run(
      filename,
      Effect.gen(function* () {
        const current = yield* (yield* Database.Service).db.transaction((tx) => LocalOperator.requireCurrent(tx))
        expect(current.operator_id).toBe(receipt.operatorID)
        expect(current.revision).toBe(1)
      }),
    )
    expect(
      code(
        await run(
          filename,
          Effect.gen(function* () {
            return yield* (yield* Database.Service).db
              .transaction((tx) => LocalOperator.requireCurrent(tx))
              .pipe(Effect.exit)
          }),
          { ...runtime, credentialBinding: "3".repeat(64) },
        ),
      ),
    ).toBe("LOCAL_OPERATOR_CONFIG_MISMATCH")
    expect(
      code(
        await run(
          filename,
          Effect.gen(function* () {
            return yield* (yield* Database.Service).db
              .transaction((tx) => LocalOperator.requireCurrent(tx))
              .pipe(Effect.exit)
          }),
          { ...runtime, installationKeyHash: "4".repeat(64) },
        ),
      ),
    ).toBe("LOCAL_OPERATOR_INSTALLATION_MISMATCH")
  }))

test("rotation and revoke fence old operator witnesses without creating IM execution state", () =>
  isolated(async (filename) => {
    const previous = await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* LocalOperator.enroll(db, enrollment)
        const current = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
        const witness = LocalOperator.mutationWitness(current)
        yield* LocalOperator.rotate(db, {
          operationID: "rotate",
          expectedRevision: current.revision,
          username: current.username,
          credentialVerifier: enrollment.credentialVerifier,
        }).pipe(Effect.provideService(LocalOperator.Mutation, witness))
        expect(
          code(
            yield* db
              .transaction((tx) => LocalOperator.requireMutation(tx))
              .pipe(Effect.provideService(LocalOperator.Mutation, witness), Effect.exit),
          ),
        ).toBe("LOCAL_OPERATOR_AUTH_REQUIRED")
        yield* zeroExecution
        return witness
      }),
    )
    await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        expect(
          code(
            yield* db
              .transaction((tx) => LocalOperator.requireMutation(tx))
              .pipe(Effect.provideService(LocalOperator.Mutation, previous), Effect.exit),
          ),
        ).toBe("LOCAL_OPERATOR_AUTH_REQUIRED")
        const current = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
        expect(current.revision).toBe(2)
        yield* LocalOperator.revoke(db, { operationID: "revoke", expectedRevision: current.revision }).pipe(
          Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(current)),
        )
        expect(Exit.isFailure(yield* db.transaction((tx) => LocalOperator.requireCurrent(tx)).pipe(Effect.exit))).toBe(
          true,
        )
        yield* zeroExecution
      }),
    )
  }))
