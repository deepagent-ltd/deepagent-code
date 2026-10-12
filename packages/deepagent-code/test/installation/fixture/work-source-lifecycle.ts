// Controlled current-reader/Native ports, with the original coordinator, three provider turns,
// Read registry, encrypted Host sealer, durable tool effects and historical consumers. This is
// caller integration evidence; real Go/DeepSeek/Desktop acceptance remains a separate gate.
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"
import { createHmac, randomBytes } from "node:crypto"
import { Cause, Context, Effect, Layer, Option, Semaphore } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import { sql } from "drizzle-orm"

const installation = await fs.realpath(await fs.mkdtemp("/tmp/dac-work-source-lifecycle-"))
process.env.DEEPAGENT_CODE_TEST_HOME = installation
await import("@deepagent-code/core/session")
const { RestrictedRunnerFixture } = await import("../../../../core/test/fixture/restricted-runner")
const { Database } = await import("@deepagent-code/core/database/database")
const { WorkAuthority } = await import("@deepagent-code/core/session/work-authority")
const { WorkAuthoritySchema } = await import("@deepagent-code/core/session/work-authority.schema")
const { WorkExecutionProfile } = await import("@deepagent-code/core/session/work-execution-profile")
const { WorkFileCapability } = await import("@deepagent-code/core/session/work-file-capability")
const { WorkToolPolicy } = await import("@deepagent-code/core/session/work-tool-policy")
const { WorkCountAcquisition } = await import("@deepagent-code/core/session/work-count-acquisition")
const { SessionExecution } = await import("@deepagent-code/core/session/execution")
const { SessionSchema } = await import("@deepagent-code/core/session/schema")
const { V2ToolEffect } = await import("@deepagent-code/core/session/runner/v2-tool-effect")
const { V2ToolEffectTable } = await import("@deepagent-code/core/session/runner/v2-tool-effect.sql")
const { AgentV2 } = await import("@deepagent-code/core/agent")
const { ToolRegistry } = await import("@deepagent-code/core/tool/registry")
const { ReadTool } = await import("@deepagent-code/core/tool/read")
const { FileSystem } = await import("@deepagent-code/core/filesystem")
const { Image } = await import("@deepagent-code/core/image")
const { PermissionV2 } = await import("@deepagent-code/core/permission")
const { CanonicalJson } = await import("@deepagent-code/core/util/canonical-json")
const { Hash } = await import("@deepagent-code/core/util/hash")
const { LocalTaskAuthority } = await import("../../../src/im/local-task-authority")
const { WorkLeafProof } = await import("../../../src/installation/work-leaf-proof")

const mode = process.argv[2] ?? "complete"
assert(["complete", "revoked", "retired"].includes(mode))
const state = { targetReads: 0, ordinaryReads: 0, verified: 0, seals: 0, preparations: 0,
  preparationMs: 0, inSQLPreparations: 0, historyIO: 0, revoked: false }
const readerLock = Semaphore.makeUnsafe(1)
const countKey = randomBytes(32)
const countMac = (record: unknown) => createHmac("sha256", countKey)
  .update("controlled-multi-turn-count\0").update(CanonicalJson.stringify(record)).digest("hex")
const count = WorkCountAcquisition.Authority.of({
  requireCapture: () => Effect.die("No legacy count in project fixture"),
  authenticate: () => Effect.die("No legacy count in project fixture"),
  verify: () => Effect.die("No legacy count in project fixture"),
  requireProjectCapture: () => Effect.void,
  authenticateProject: (record) => Effect.succeed(countMac(record)),
  verifyProject: (record, mac) => countMac(record) === mac ? Effect.void
    : Effect.fail(WorkCountAcquisition.failure("COUNT_INVALID_RECORD")),
})
const unavailable = () => new WorkAuthoritySchema.Error({ code: "PROFILE_UNAVAILABLE", message: "Controlled original reader is unavailable" })
const files = Layer.succeed(WorkFileCapability.Service, {
  open: () => Effect.acquireRelease(Effect.promise(() => fs.open(installation, "r")).pipe(
    Effect.map((file) => Object.freeze({ file }) as unknown as import("@deepagent-code/core/session/work-file-capability").Root)),
    (root) => Effect.promise(() => (root as unknown as { file: FileHandle }).file.close())),
  current: () => Effect.sleep("10 millis"),
  read: () => { state.targetReads++; return Effect.fail(new WorkFileCapability.Error({ code: "WORK_FILE_UNKNOWN", message: "No data read is offered in this source-lifecycle fixture" })) },
  describe: () => undefined,
  live: () => ({ helpers: 0, queued: 0, inFlight: 0, observations: 0 }),
})
const ordinary = () => Effect.sync(() => { state.ordinaryReads++; throw new Error("Ordinary filesystem is outside this Work") })
const dependencies = Layer.mergeAll(files,
  Layer.succeed(FileSystem.Service, { read: ordinary, resolveReadPath: ordinary, readTool: ordinary,
    resolveRoot: ordinary, list: ordinary, resolveList: ordinary, listResolved: ordinary, listPage: ordinary,
    listPageResolved: ordinary, find: ordinary, grep: ordinary, isIgnored: () => false }),
  Layer.succeed(Image.Service, { normalize: () => Effect.die("No image in this fixture") }),
  Layer.succeed(PermissionV2.Service, { assert: () => Effect.void, ask: ordinary, reply: ordinary,
    get: ordinary, forSession: ordinary, list: ordinary }),
  ToolRegistry.defaultLayer,
)
await Effect.runPromise(LocalTaskAuthority.initializeInstallation())
const registry = Layer.mergeAll(dependencies, ReadTool.layer.pipe(Layer.provide(dependencies)))
const definitionHash = await Effect.runPromise(Effect.gen(function* () {
  const materialized = yield* (yield* ToolRegistry.Service).materialize()
  return Hash.sha256(CanonicalJson.stringify(ToolRegistry.inspect(materialized, "read")!.definition))
}).pipe(Effect.provide(registry), Effect.scoped))
const fixture = await RestrictedRunnerFixture.create("source-multi-tool-history", {
  projectDefinitionHash: definitionHash,
  generation: async (turn) => {
    const call = (index: number) => ({ id: `fn_${turn}_${index}`, call_id: `call_${turn}_${index}`,
      type: "function_call", name: "read", arguments: JSON.stringify({ path: "." }), status: "completed" })
    const events = turn <= 2 ? Array.from({ length: 4 }, (_, index) => call(index)).flatMap((item, output_index) => [
      { type: "response.output_item.added", output_index, item: { ...item, arguments: "", status: "in_progress" } },
      { type: "response.function_call_arguments.delta", item_id: item.id, output_index, delta: item.arguments },
      { type: "response.output_item.done", output_index, item },
    ]) : [{ type: "response.output_text.delta", item_id: "msg_final", delta: "accepted" }]
    const response = { id: `resp_${turn}`, output: turn <= 2 ? Array.from({ length: 4 }, (_, index) => call(index)) : [],
      usage: { input_tokens: 41, output_tokens: 12, total_tokens: 53, output_tokens_details: { reasoning_tokens: 5 } } }
    return new Response([...events, { type: "response.completed", response }]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
  },
})

try {
  const result = await RestrictedRunnerFixture.open(fixture, Effect.gen(function* () {
    const execution = yield* SessionExecution.Service
    const exit = yield* execution.resume(SessionSchema.ID.make(fixture.candidate.binding.sessionID)).pipe(Effect.exit)
    const db = (yield* Database.Service).db
    const recorded = yield* db.select().from(V2ToolEffectTable).get().pipe(Effect.orDie)
    if (recorded) {
      const producerCount = state.preparations
      yield* db.run("UPDATE test_work_source SET enabled=0").pipe(Effect.orDie)
      const service = Context.get(yield* Layer.build(V2ToolEffect.layer.pipe(
        Layer.provide(Layer.succeed(Database.Service, yield* Database.Service)))), V2ToolEffect.Service)
      const input = { sessionId: recorded.session_id, providerAttemptId: recorded.provider_attempt_id,
        receiptId: recorded.receipt_id, toolCallId: recorded.tool_call_id, toolName: recorded.tool_name,
        effectKind: recorded.effect_kind, state: recorded.state, outcomeHash: recorded.outcome_hash,
        ownerToken: recorded.owner_token, now: recorded.time_created }
      assert.equal((yield* service.record(input)).effectId, recorded.effect_id)
      assert.equal((yield* service.record({ ...input, outcomeHash: "0".repeat(64) }).pipe(Effect.exit))._tag, "Failure")
      assert.equal(state.preparations, producerCount)
    }
    return { success: exit._tag === "Success", error: exit._tag === "Failure" ? Cause.pretty(exit.cause) : null,
      facts: yield* RestrictedRunnerFixture.facts,
      effects: yield* db.all<{ known: string | null; state: string }>(sql`SELECT known_read_proof known,state FROM session_v2_tool_effect`) }
  }), {
    count,
    onPrepare: Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const client = Reflect.get(Reflect.get(db, "session"), "client") as SqlClient
      if (Option.isSome(yield* Effect.serviceOption(client.transactionService))) {
        state.inSQLPreparations++
        return yield* unavailable()
      }
      const started = performance.now()
      yield* readerLock.withPermits(1)(db.all("SELECT enabled FROM test_work_source").pipe(
        Effect.andThen(Effect.sleep("10 millis")), Effect.asVoid, Effect.mapError(unavailable)))
      state.preparations++
      state.preparationMs += performance.now() - started
    }),
    project: Effect.gen(function* () {
      const database = yield* Database.Service
      const profile = yield* WorkExecutionProfile.Service
      const original = Context.get(yield* Layer.build(WorkLeafProof.layer.pipe(
        Layer.provide(Layer.mergeAll(registry, Layer.succeed(Database.Service, database),
          Layer.succeed(WorkExecutionProfile.Service, profile))))), WorkToolPolicy.LeafProof)
      const tools = Context.get(yield* Layer.build(registry), ToolRegistry.Service)
      return { tools, count,
        agents: { select: (id?: string) => Effect.succeed({ id: AgentV2.ID.make(id ?? fixture.candidate.binding.agentID), info: undefined }),
          get: () => Effect.succeed(undefined), all: () => Effect.succeed([]), default: () => Effect.succeed(undefined),
          resolve: () => Effect.succeed(undefined), update: ordinary, transform: ordinary },
        files: Context.get(yield* Layer.build(files), WorkFileCapability.Service),
        proof: { ...original,
          seal: (witness, hash) => { state.seals++; return original.seal(witness, hash) },
          verify: (id) => Effect.gen(function* () {
            yield* Effect.sleep("140 millis")
            const known = yield* original.verify(id)
            state.verified++
            if (state.verified % 8 === 0) {
              // The last native-history preparation deliberately outlives its just-captured
              // witness. Canonical's consuming seam must obtain a new original observation.
              yield* Effect.sleep("1100 millis")
              state.historyIO++
              if (mode !== "complete" && state.seals === 8 && !state.revoked) {
                state.revoked = true
                yield* database.db.run(mode === "revoked" ? "UPDATE test_work_source SET enabled=0"
                  : "UPDATE context_location_identity SET retired_at=1").pipe(Effect.orDie)
              }
            }
            return known
          }),
        },
      }
    }),
  })
  assert.equal(state.inSQLPreparations, 0)
  assert.equal(state.targetReads, 0)
  assert.equal(state.ordinaryReads, 0)
  assert.equal(state.seals, 8, result.error ?? "Missing original tool seals")
  assert.equal(result.effects.length, 8)
  assert(result.effects.every((effect) => effect.state === "settled" && effect.known !== null))
  assert.equal(result.success, mode === "complete", result.error ?? "Unexpected result")
  assert.equal(fixture.state.bodies.length, mode === "complete" ? 3 : 2)
  assert.equal(result.facts.receipts.length, mode === "complete" ? 3 : 2)
  assert(result.facts.receipts.every((receipt) => receipt.state === "settled"))
  assert(state.historyIO > 0)
  assert.equal(result.facts.sessions[0]?.execution_claim_token, null)
  assert.equal(result.facts.works[0]?.outcome, mode === "complete" ? "succeeded" : "pending")
  const output = { ok: true, mode, schemaVersion: "work-execution.v2", physicalTurns: fixture.state.bodies.length,
    durableEffects: result.effects.length, originalSeals: state.seals, historicalVerifications: state.verified,
    freshRequests: fixture.observed.sourceFreshRequests.filter(Boolean).length,
    defaultRequests: fixture.observed.sourceFreshRequests.filter((fresh) => !fresh).length, ...state,
    fileDB: fixture.filename, originalReader: "controlled semaphore and actual SQL read", acceptance: false }
  await Bun.write(path.join(fixture.root, "source-lifecycle-safe.json"), JSON.stringify(output, null, 2))
  console.info("WORK_SOURCE_LIFECYCLE_RESULT", JSON.stringify(output))
} finally {
  await fixture.close()
}
