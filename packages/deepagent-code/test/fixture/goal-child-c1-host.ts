// Actual AppRuntime/Location/SessionRunner. Only the loopback provider response is deterministic.
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createServer } from "node:http"
import net from "node:net"
import { Cause, Effect, Exit, Schema } from "effect"
import { sql } from "drizzle-orm"
import { AgentV2 } from "@deepagent-code/core/agent"
import { Database } from "@deepagent-code/core/database/database"
import { GoalChild } from "@deepagent-code/core/deepagent/goal-child"
import { GoalChildPolicy } from "@deepagent-code/core/deepagent/goal-child-policy"
import { GoalChildResult } from "@deepagent-code/core/deepagent/goal-child-result"
import { GoalTickCheckpoint } from "@deepagent-code/core/deepagent/goal-tick-checkpoint"
import { GoalChildExecution } from "@deepagent-code/core/deepagent/goal-child-execution"
import { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import { GoalControl } from "@deepagent-code/core/deepagent/goal-control"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { PluginBoot } from "@deepagent-code/core/plugin/boot"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { GoalControlFixture } from "../../../core/test/fixture/goal-control"
import { WorkAuthorityFixture } from "../../../core/test/fixture/work-authority"
import { GoalChildPolicyHost } from "@/session/goal-child-policy"
import { AppRuntime } from "@/effect/app-runtime"
import { Server } from "@/server/server"
import { SessionSteer } from "@/session/steer"
import { SessionID } from "@/session/schema"

const root = process.argv[2]!
const scenario = process.argv[3]!
const directory = path.join(root, "project")
if (scenario === "control-race-actor") {
  const input = await Bun.file(path.join(root, "race-input.json")).json()
  await Bun.write(path.join(root, "control-started.json"), JSON.stringify({ pid: process.pid }))
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const first = yield* GoalControl.control(db, input).pipe(Effect.exit)
      assert(Exit.isFailure(first))
      const error = Exit.isFailure(first) ? Cause.squash(first.cause) : undefined
      assert(error && typeof error === "object" && "code" in error && error.code === "unavailable")
      yield* Effect.promise(() =>
        Bun.write(path.join(root, "control-attempt.json"), JSON.stringify({ code: "unavailable" })),
      )
      yield* Effect.promise(async () => {
        const deadline = Date.now() + 5000
        while (!(await Bun.file(path.join(root, "control-retry")).exists())) {
          if (Date.now() > deadline) throw new Error("control retry was not released")
          await Bun.sleep(10)
        }
      })
      return yield* GoalControl.control(db, input)
    }).pipe(Effect.provide(WorkAuthorityFixture.database(path.join(root, "authority.sqlite"))), Effect.scoped),
  )
  await Bun.write(path.join(root, "control-result.json"), JSON.stringify(result))
  process.exit(0)
}
if (scenario.startsWith("recover-")) {
  const result = await AppRuntime.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const rows = yield* db.all<{ permit_id: string }>("SELECT permit_id FROM goal_tick_checkpoint")
      assert.equal(rows.length, 1)
      const row = (yield* GoalTickCheckpoint.read(db, rows[0].permit_id))!
      const before = yield* db.all("SELECT * FROM session_v2_provider_turn_receipt")
      const changes = (yield* db.all<{ value: number }>("SELECT total_changes() AS value"))[0].value
      const projected = yield* (
        scenario === "recover-committed"
          ? GoalTickCheckpoint.settle(db, { permitID: row.permit_id, revision: row.revision - 1 })
          : GoalTickCheckpoint.projectMirror(db, {
              permitID: row.permit_id,
              documentID: row.journal.mirrors[0].documentID,
              directory: path.join(root, "documents"),
            })
      ).pipe(Effect.exit)
      if (scenario === "recover-conflict" || scenario === "recover-paused") assert(Exit.isFailure(projected))
      else {
        assert(
          Exit.isSuccess(projected),
          Exit.isFailure(projected) ? Cause.pretty(projected.cause) : "missing projection",
        )
        if (Exit.isFailure(projected)) throw new Error("projection failed")
        yield* GoalTickCheckpoint.settle(db, { permitID: row.permit_id, revision: projected.value.revision })
      }
      assert.deepEqual(yield* db.all("SELECT * FROM session_v2_provider_turn_receipt"), before)
      if (scenario === "recover-committed")
        assert.equal((yield* db.all<{ value: number }>("SELECT total_changes() AS value"))[0].value, changes)
      return {
        checkpoint: yield* GoalTickCheckpoint.read(db, row.permit_id),
        permits: yield* db.all("SELECT * FROM goal_tick_permit"),
        controls: yield* db.all("SELECT * FROM goal_control"),
        providerReceipts: before.length,
        inputs: yield* db.all("SELECT id FROM session_input"),
        projection: Exit.isSuccess(projected) ? "confirmed" : "rejected",
      }
    }),
  )
  await Bun.write(path.join(root, "recovered.json"), JSON.stringify(result))
  process.exit(0)
}
const requests: unknown[] = []
const provider = createServer(async (request, response) => {
  assert.equal(request.url, scenario === "anthropic" ? "/v1/messages" : "/v1/chat/completions")
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  requests.push(JSON.parse(Buffer.concat(chunks).toString()))
  await Bun.write(path.join(root, "provider.json"), JSON.stringify(requests))
  response.writeHead(200, { "content-type": "text/event-stream" })
  if (scenario === "anthropic") {
    const emit = (event: object) => response.write(`data: ${JSON.stringify(event)}\n\n`)
    emit({
      type: "message_start",
      message: {
        id: "msg-c1",
        type: "message",
        role: "assistant",
        content: [],
        model: "test-model",
        stop_reason: null,
        usage: { input_tokens: 15, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
      },
    })
    emit({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
    emit({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "known stage result" } })
    emit({ type: "content_block_stop", index: 0 })
    emit({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: 15, output_tokens: 10, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
    })
    emit({ type: "message_stop" })
    response.end()
    return
  }
  const emit = (value: unknown) =>
    response.write(
      `data: ${JSON.stringify({ id: "chatcmpl-c1", object: "chat.completion.chunk", created: 1, model: "test-model", ...Object(value) })}\n\n`,
    )
  emit({
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          content: scenario === "structured" && requests.length === 3 ? '{"ok":true}' : "known stage result",
        },
      },
    ],
  })
  emit({
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    ...(scenario === "missing-usage"
      ? {}
      : {
          usage: {
            prompt_tokens: 20,
            completion_tokens: 10,
            total_tokens: 30,
            prompt_tokens_details: { cached_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 0 },
          },
        }),
  })
  response.end("data: [DONE]\n\n")
})
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve))
const address = provider.address()
assert(address && typeof address !== "string")
await Bun.write(
  path.join(directory, "deepagent-code.json"),
  JSON.stringify({
    formatter: false,
    lsp: false,
    model: "fixture/test-model",
    permission: { "*": "allow" },
    provider: {
      fixture: {
        name: "C1 fixture",
        npm: scenario === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible",
        env: [],
        options: { apiKey: "private-fixture", baseURL: `http://127.0.0.1:${address.port}/v1` },
        models: {
          "test-model": {
            name: "Fixture",
            tool_call: true,
            limit: { context: 100000, output: 10000 },
            cost: { input: 0, output: 0 },
          },
        },
      },
    },
  }),
)
const rg = Bun.which("rg")!
const bin = path.join(root, "home/.deepagent/code/cache/bin")
await fs.mkdir(bin, { recursive: true })
await fs.copyFile(rg, path.join(bin, "rg"))
let listener: Awaited<ReturnType<typeof Server.listen>> | undefined
try {
  await AppRuntime.runPromise(WorkAuthorityFixture.initialize())
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
  const port = probe.address()
  assert(port && typeof port !== "string")
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  listener = await Server.listen({ hostname: "127.0.0.1", port: port.port })
  const result = await AppRuntime.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      const parent = yield* sessions.create({
        location: { directory: AbsolutePath.make(directory) },
        model: { providerID: ProviderV2.ID.make("fixture"), id: ModelV2.ID.make("test-model") },
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      })
      const documents = new DocumentStore(path.join(root, "documents"))
      const plan = documents.create({
        type: "plan",
        scope: `run:${parent.id}`,
        body: "original plan",
        description: "C1 projection",
        provenance: { source: "runner", run_ref: parent.id },
      })
      const start = {
        sessionID: parent.id,
        requestID: "c1-start",
        requestHash: GoalControl.fingerprint(parent.id),
        planDocId: plan.id,
        initialization: {
          ...GoalControlFixture.initialization,
          spec: { ...GoalControlFixture.initialization.spec, planDocId: plan.id },
          planHash: plan.hash.slice(7),
          model: { providerID: "fixture", modelID: "test-model" },
        },
        driverMode: "event" as const,
      }
      const goal = yield* GoalControl.reserveStart(db, start)
      yield* GoalControl.activate(db, { ...start, goalId: goal.row.goal_id })
      const tick = yield* GoalControl.beginTick(db, {
        sessionID: parent.id,
        goalId: goal.row.goal_id,
        planDocId: plan.id,
        revision: 1,
        seq: 0,
        expectedPlanVersion: 1,
        mode: "event",
      })
      const locations = yield* LocationServiceMap
      const pair = yield* Effect.gen(function* () {
        yield* (yield* PluginBoot.Service).wait()
        const agents = yield* AgentV2.Service
        return { parent: yield* agents.snapshot!(parent.agent), child: yield* agents.snapshot!("goal-worker") }
      }).pipe(Effect.provide(locations.get(parent.location)))
      const again = yield* Effect.gen(function* () {
        yield* (yield* PluginBoot.Service).wait()
        const agents = yield* AgentV2.Service
        return { parent: yield* agents.snapshot!(parent.agent), child: yield* agents.snapshot!("goal-worker") }
      }).pipe(
        Effect.provide(
          locations.get({
            directory: parent.location.directory,
            ...(parent.location.workspaceID ? { workspaceID: parent.location.workspaceID } : {}),
          }),
        ),
      )
      const identity = (value: typeof pair) => ({
        instanceID: AgentV2.snapshotView(value.parent)?.instanceID,
        generation: AgentV2.snapshotView(value.parent)?.generation,
        hash: GoalChildPolicy.roleHash(value.parent, value.child),
      })
      yield* Effect.promise(() =>
        Bun.write(
          path.join(root, "roster-identity.json"),
          JSON.stringify({
            first: identity(pair),
            second: identity(again),
            location: parent.location,
            keys: Object.keys(parent.location),
          }),
        ),
      )
      assert.deepEqual(
        identity(pair),
        identity(again),
        "Structurally equal Location references must share the actual roster instance",
      )
      const mode =
        scenario === "structured" || scenario === "prior-result-unknown" ? ("structured" as const) : ("plain" as const)
      const text = "Return a short deterministic result. Do not call tools."
      const role = {
        key: "worker.0",
        agent: "goal-worker",
        kind: "worker" as const,
        ordinal: 0,
        criterion: null,
        round: null,
        lens: null,
        mode,
        promptHash: GoalControl.fingerprint(new Prompt({ text })),
        policyHash: GoalChildPolicy.roleHash(pair.parent, pair.child)!,
      }
      if (scenario === "steering")
        yield* Effect.gen(function* () {
          yield* (yield* SessionSteer.Service).admit({
            sessionID: SessionID.make(parent.id),
            prompt: new Prompt({ text: "accepted tick steering" }),
            delivery: "goal_steer",
            correlationID: "frozen-steer",
          })
        }).pipe(Effect.provide(SessionSteer.layer))
      const checkpoint = yield* GoalTickCheckpoint.begin(db, {
        permitID: tick.permit.permit_id,
        permitToken: tick.permit.token,
        roles: [role],
        budgets: {
          resultSlots: mode === "plain" ? 1 : 3,
          effectSlots: 0,
          mirrors: [{ documentID: plan.id, bytes: 4096 }],
          nextStateBytes: 4096,
        },
      })
      if (scenario === "steering") {
        assert.equal(checkpoint.journal.parent.steering.rows.length, 1)
        yield* Effect.gen(function* () {
          yield* (yield* SessionSteer.Service).admit({
            sessionID: SessionID.make(parent.id),
            prompt: new Prompt({ text: "next tick only" }),
            delivery: "goal_steer",
            correlationID: "future-steer",
          })
        }).pipe(Effect.provide(SessionSteer.layer))
      }
      const policy = yield* GoalChildPolicyHost.prepare({
        permitID: tick.permit.permit_id,
        roleKey: role.key,
        agent: "goal-worker",
        mode,
        ...(mode === "structured" ? { resultSchema: Schema.Struct({ ok: Schema.Boolean }) } : {}),
      })
      const execution = yield* SessionExecution.Service
      const owned = yield* SessionExecution.requireOwned(execution)
      const stages =
        mode === "structured" ? (["research", "finalizer.1", "finalizer.2"] as const) : (["plain"] as const)
      for (const stage of stages) {
        const child = yield* GoalChild.admitV2(db, sessions, {
          permitID: tick.permit.permit_id,
          permitToken: tick.permit.token,
          roleKey: role.key,
          mode,
          stage,
          text: stage === "plain" || stage === "research" ? text : `Fixed ${stage} after known predecessor`,
          steeringHash: GoalControl.fingerprint([]),
          promptPolicyHash: role.promptHash,
          policy,
        })
        const run = yield* owned.run(GoalChildExecution.target(child.unit))
        assert.equal(run.status, "started")
        if (run.status !== "started") throw new Error("unexpected owned start")
        const settled = yield* owned.await(run.receipt)
        assert(
          settled.status === "settled" && Exit.isSuccess(settled.exit),
          settled.status === "settled" && Exit.isFailure(settled.exit)
            ? Cause.pretty(settled.exit.cause)
            : "owned failed",
        )
        if (scenario === "ledger-limits") {
          for (const limit of ["providers", "tools", "bytes"] as const) {
            const checked = yield* db
              .transaction(
                (tx) =>
                  Effect.gen(function* () {
                    if (limit === "providers")
                      yield* tx
                        .run(
                          sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<512)
              INSERT INTO session_v2_provider_turn_receipt (receipt_id,session_id,request_ordinal,activity_id,provider_turn_seq,user_message_id,history_prompt_epoch,request_input_hash,provider_id,model_id,protocol,owner_mode,owner_token,state,created_at)
              SELECT 'oversize-'||i,session_id,request_ordinal+i,activity_id,provider_turn_seq+i,user_message_id,history_prompt_epoch,request_input_hash,provider_id,model_id,protocol,owner_mode,owner_token,'preparing',created_at FROM session_v2_provider_turn_receipt,n WHERE session_id=${child.unit.child_session_id} AND request_ordinal=1`,
                        )
                        .pipe(Effect.orDie)
                    if (limit === "tools")
                      yield* tx
                        .run(
                          sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<4097)
              INSERT INTO session_v2_tool_effect_admission (admission_id,session_id,provider_attempt_id,receipt_id,tool_call_id,tool_name,effect_kind,owner_token,time_created)
              SELECT 'oversize-'||i,session_id,provider_attempt_id,receipt_id,'call-'||i,'fixture','mutating',owner_token,created_at FROM session_v2_provider_turn_receipt,n WHERE session_id=${child.unit.child_session_id}`,
                        )
                        .pipe(Effect.orDie)
                    if (limit === "bytes") {
                      // 11.2 MiB of NUL bytes becomes 67.2 MiB after canonical JSON escaping. SQLite's
                      // text length stops at NUL; the real BLOB/JSON byte measurement must still reject.
                      yield* tx
                        .run(
                          sql`UPDATE session_v2_provider_turn_receipt SET error_code=replace(hex(zeroblob(11200000)),'00',char(0)) WHERE session_id=${child.unit.child_session_id}`,
                        )
                        .pipe(Effect.orDie)
                      const bytes = (yield* tx
                        .all<{
                          raw: number
                          encoded: number
                        }>(
                          sql`SELECT length(CAST(error_code AS BLOB)) AS raw,length(CAST(json_array(error_code) AS BLOB)) AS encoded FROM session_v2_provider_turn_receipt WHERE session_id=${child.unit.child_session_id}`,
                        )
                        .pipe(Effect.orDie))[0]
                      assert.equal(bytes.raw, 11200000)
                      assert(bytes.encoded > 67108864)
                    }
                    const rejected = yield* GoalChildResult.inspect(tx, child.unit.unit_id, stage).pipe(Effect.exit)
                    assert(Exit.isFailure(rejected))
                    const error = Exit.isFailure(rejected) ? Cause.squash(rejected.cause) : undefined
                    assert(
                      error instanceof Error &&
                        error.message.includes(
                          limit === "bytes" ? "bounded inspection bytes" : "bounded inspection count",
                        ),
                      String(error),
                    )
                    assert.equal((yield* GoalTickCheckpoint.read(tx, tick.permit.permit_id))!.journal.results.length, 0)
                    assert.equal((yield* GoalTickCheckpoint.read(tx, tick.permit.permit_id))!.reserved_bytes, 1048576)
                    return yield* Effect.fail("fixture rollback after actual bounds rejection")
                  }),
                { behavior: "immediate" },
              )
              .pipe(Effect.exit)
            assert(
              Exit.isFailure(checked) &&
                Cause.squash(checked.cause) === "fixture rollback after actual bounds rejection",
              Exit.isFailure(checked) ? Cause.pretty(checked.cause) : "unexpected success",
            )
          }
          assert.equal(requests.length, 1)
        }
        const proof = yield* GoalChildResult.inspect(db, child.unit.unit_id, stage).pipe(Effect.exit)
        if (scenario === "missing-usage") {
          assert(Exit.isFailure(proof))
          const repeated = yield* owned
            .run(GoalChildExecution.target((yield* GoalChild.read(db, child.unit.unit_id))!))
            .pipe(Effect.exit)
          assert(Exit.isFailure(repeated), "unknown business result must not replay the already promoted input")
          assert.equal(requests.length, 1)
          break
        }
        assert(Exit.isSuccess(proof), Exit.isFailure(proof) ? Cause.pretty(proof.cause) : "missing proof")
        if (Exit.isFailure(proof)) throw new Error("missing result")
        if (scenario === "result-rollback") {
          yield* db
            .run(
              "CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON goal_tick_checkpoint WHEN json_array_length(NEW.journal,'$.results')>0 BEGIN SELECT RAISE(ABORT,'test rollback'); END",
            )
            .pipe(Effect.orDie)
          const failed = yield* GoalTickCheckpoint.recordResult(db, proof.value).pipe(Effect.exit)
          assert(Exit.isFailure(failed))
          const untouched = (yield* GoalChild.read(db, child.unit.unit_id))!
          assert.equal(untouched.inputs[0].resultRef, null)
          assert.equal((yield* GoalTickCheckpoint.read(db, tick.permit.permit_id))!.journal.results.length, 0)
          yield* db.run("DROP TRIGGER fail_checkpoint").pipe(Effect.orDie)
          yield* db
            .run(
              "CREATE TRIGGER ignore_unit_result BEFORE UPDATE ON goal_child_unit WHEN json_extract(NEW.inputs,'$[0].resultRef') IS NOT NULL BEGIN SELECT RAISE(IGNORE); END",
            )
            .pipe(Effect.orDie)
          const ignored = yield* GoalTickCheckpoint.recordResult(db, proof.value).pipe(Effect.exit)
          assert(Exit.isFailure(ignored), "a skipped actual input receipt cannot advance the checkpoint")
          assert.equal((yield* GoalTickCheckpoint.read(db, tick.permit.permit_id))!.journal.results.length, 0)
          assert.equal((yield* GoalChild.read(db, child.unit.unit_id))!.inputs[0].resultRef, null)
          yield* db.run("DROP TRIGGER ignore_unit_result").pipe(Effect.orDie)
        }
        const recorded = yield* GoalTickCheckpoint.recordResult(db, proof.value)
        assert.equal(recorded.journal.results.length, [...(stages as readonly string[])].indexOf(stage) + 1)
        const retry = yield* GoalTickCheckpoint.recordResult(db, proof.value)
        assert.equal(retry.revision, recorded.revision)
        if (scenario === "prior-result-unknown") {
          yield* db
            .run(
              sql`INSERT INTO session_v2_tool_effect_admission (admission_id,session_id,provider_attempt_id,receipt_id,tool_call_id,tool_name,effect_kind,owner_token,time_created)
          SELECT 'late-unknown',session_id,provider_attempt_id,receipt_id,'late-unknown','fixture','mutating',owner_token,created_at FROM session_v2_provider_turn_receipt WHERE session_id=${child.unit.child_session_id}`,
            )
            .pipe(Effect.orDie)
          const next = yield* GoalChild.admitV2(db, sessions, {
            permitID: tick.permit.permit_id,
            permitToken: tick.permit.token,
            roleKey: role.key,
            mode,
            stage: "finalizer.1",
            text: "Must not execute after the predecessor becomes unknown",
            steeringHash: GoalControl.fingerprint([]),
            promptPolicyHash: role.promptHash,
            policy,
          }).pipe(Effect.exit)
          assert(Exit.isFailure(next))
          assert.equal((yield* db.all("SELECT * FROM session_input")).length, 1)
          assert.equal(requests.length, 1)
          break
        }
      }
      if (
        scenario.startsWith("cold-") ||
        scenario === "settle-rollback" ||
        scenario === "control-race" ||
        scenario === "steering"
      ) {
        const recorded = (yield* GoalTickCheckpoint.read(db, tick.permit.permit_id))!
        const prepared = yield* GoalTickCheckpoint.prepareMirrors(db, {
          permitID: recorded.permit_id,
          revision: recorded.revision,
          mirrors: [
            {
              documentID: plan.id,
              expectedVersion: plan.version,
              expectedHash: plan.hash,
              payload: "exact frozen next plan",
              payloadHash: GoalControl.fingerprint("exact frozen next plan"),
              state: "pending",
              observedVersion: null,
              observedHash: null,
            },
          ],
          nextState: JSON.stringify({ nextSeq: 1, planVersion: 2, phase: "running" }),
        })
        if (scenario === "cold-after") {
          yield* db
            .run(
              "CREATE TRIGGER fail_projection BEFORE UPDATE ON goal_tick_checkpoint WHEN json_extract(NEW.journal,'$.mirrors[0].state')='confirmed' BEGIN SELECT RAISE(ABORT,'test projection rollback'); END",
            )
            .pipe(Effect.orDie)
          assert(
            Exit.isFailure(
              yield* GoalTickCheckpoint.projectMirror(db, {
                permitID: prepared.permit_id,
                documentID: plan.id,
                directory: path.join(root, "documents"),
              }).pipe(Effect.exit),
            ),
          )
          assert.equal(new DocumentStore(path.join(root, "documents")).get(plan.id)!.version, 2)
          assert.equal((yield* GoalTickCheckpoint.read(db, prepared.permit_id))!.journal.mirrors[0].state, "pending")
          yield* db.run("DROP TRIGGER fail_projection").pipe(Effect.orDie)
        }
        if (scenario === "cold-conflict") {
          const ready = path.join(root, "doc-writer-ready")
          const start = path.join(root, "doc-writer-start")
          const writer = Bun.spawn(
            [
              process.execPath,
              path.resolve(import.meta.dir, "../../../core/test/deepagent/document-store-writer.ts"),
              path.join(root, "documents"),
              plan.id,
              "different external revision",
              ready,
              start,
            ],
            { env: process.env, stdout: "pipe", stderr: "pipe" },
          )
          const output = Promise.all([new Response(writer.stdout).text(), new Response(writer.stderr).text()])
          yield* Effect.promise(async () => {
            const deadline = Date.now() + 5000
            while (!(await Bun.file(ready).exists())) {
              if (Date.now() > deadline || writer.exitCode !== null) throw new Error("document writer unavailable")
              await Bun.sleep(10)
            }
            await Bun.write(start, "start")
            assert.equal(await writer.exited, 0)
            await Bun.write(path.join(root, "document-writer.log"), (await output).join("\n"))
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (writer.exitCode === null) writer.kill("SIGKILL")
              }),
            ),
          )
        }
        if (scenario === "cold-paused")
          yield* GoalControl.control(db, {
            sessionID: parent.id,
            goalId: goal.row.goal_id,
            expectedRevision: 1,
            requestID: "pause-before-projection",
            action: "pause",
          })
        if (scenario.startsWith("cold-")) {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(root, "kill-ready.json"),
              JSON.stringify({
                permitID: prepared.permit_id,
                requests: requests.length,
                doc: new DocumentStore(path.join(root, "documents")).get(plan.id),
              }),
            ),
          )
          yield* Effect.never
        }
        if (scenario === "control-race") {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(root, "race-input.json"),
              JSON.stringify({
                sessionID: parent.id,
                goalId: goal.row.goal_id,
                expectedRevision: 1,
                requestID: "concurrent-control",
                action: "pause",
              }),
            ),
          )
          const raced = yield* db.transaction(
            () =>
              Effect.gen(function* () {
                const actor = Bun.spawn([process.execPath, import.meta.path, root, "control-race-actor"], {
                  env: process.env,
                  stdout: "pipe",
                  stderr: "pipe",
                })
                const output = Promise.all([new Response(actor.stdout).text(), new Response(actor.stderr).text()])
                yield* Effect.promise(async () => {
                  const deadline = Date.now() + 5000
                  while (!(await Bun.file(path.join(root, "control-attempt.json")).exists())) {
                    if (Date.now() > deadline || actor.exitCode !== null) {
                      actor.kill("SIGKILL")
                      throw new Error("control actor unavailable")
                    }
                    await Bun.sleep(10)
                  }
                })
                assert.equal(
                  (yield* db.all("SELECT * FROM goal_control_command WHERE request_id='concurrent-control'")).length,
                  0,
                )
                const projected = yield* GoalTickCheckpoint.projectMirror(db, {
                  permitID: prepared.permit_id,
                  documentID: plan.id,
                  directory: path.join(root, "documents"),
                })
                assert.equal((yield* GoalControl.get(db, goal.row.goal_id))!.requested_phase, "running")
                return { actor, output, projected }
              }),
            { behavior: "immediate" },
          )
          yield* Effect.promise(() => Bun.write(path.join(root, "control-retry"), "same request retry"))
          yield* Effect.promise(async () => {
            const status = await raced.actor.exited
            await Bun.write(path.join(root, "control-race.log"), (await raced.output).join("\n"))
            assert.equal(status, 0)
          })
          assert.equal((yield* GoalControl.get(db, goal.row.goal_id))!.requested_phase, "paused")
          assert.equal(DocumentStore.openExact(path.join(root, "documents"), [plan.id]).get(plan.id)!.version, 2)
          assert(
            Exit.isFailure(
              yield* GoalTickCheckpoint.settle(db, {
                permitID: prepared.permit_id,
                revision: raced.projected.revision,
              }).pipe(Effect.exit),
            ),
          )
          yield* Effect.promise(() =>
            Bun.write(
              path.join(root, "race-proof.json"),
              JSON.stringify({
                firstAttempt: "unavailable",
                actorPID: raced.actor.pid,
                documentVersion: 2,
                projection: raced.projected.journal.mirrors[0].state,
                afterControl: "paused",
                settle: "rejected",
              }),
            ),
          )
        }
        if (scenario === "settle-rollback" || scenario === "steering") {
          const projected = yield* GoalTickCheckpoint.projectMirror(db, {
            permitID: prepared.permit_id,
            documentID: plan.id,
            directory: path.join(root, "documents"),
          })
          yield* db
            .run(
              "CREATE TRIGGER fail_settle BEFORE UPDATE ON goal_tick_checkpoint WHEN NEW.state='committed' BEGIN SELECT RAISE(ABORT,'test settle rollback'); END",
            )
            .pipe(Effect.orDie)
          assert(
            Exit.isFailure(
              yield* GoalTickCheckpoint.settle(db, {
                permitID: projected.permit_id,
                revision: projected.revision,
              }).pipe(Effect.exit),
            ),
          )
          assert.equal((yield* db.all<{ state: string }>("SELECT state FROM goal_tick_permit"))[0].state, "issued")
          assert.equal((yield* db.all<{ next_seq: number }>("SELECT next_seq FROM goal_control"))[0].next_seq, 0)
          assert.equal((yield* GoalTickCheckpoint.read(db, projected.permit_id))!.state, "mirror_pending")
          if (scenario === "steering")
            assert(
              (yield* db.all<{ consumed_seq: number | null }>("SELECT consumed_seq FROM session_steer")).every(
                (row) => row.consumed_seq === null,
              ),
            )
          yield* db.run("DROP TRIGGER fail_settle").pipe(Effect.orDie)
          const committed = yield* GoalTickCheckpoint.settle(db, {
            permitID: projected.permit_id,
            revision: projected.revision,
          })
          const changes = (yield* db.all<{ value: number }>("SELECT total_changes() AS value"))[0].value
          const retry = yield* GoalTickCheckpoint.settle(db, {
            permitID: projected.permit_id,
            revision: projected.revision,
          })
          const observed = yield* GoalTickCheckpoint.settle(db, {
            permitID: projected.permit_id,
            revision: committed.revision,
          })
          assert.deepEqual(retry, committed)
          assert.deepEqual(observed, committed)
          for (const revision of [projected.revision - 1, committed.revision + 1]) {
            assert(
              Exit.isFailure(
                yield* GoalTickCheckpoint.settle(db, { permitID: projected.permit_id, revision }).pipe(Effect.exit),
              ),
            )
          }
          assert.equal((yield* db.all<{ value: number }>("SELECT total_changes() AS value"))[0].value, changes)
          assert.equal(requests.length, 1)
          if (scenario === "steering") {
            const rows = yield* db.all<{ correlation_id: string; consumed_seq: number | null }>(
              "SELECT correlation_id,consumed_seq FROM session_steer ORDER BY seq",
            )
            assert.equal(rows.length, 2)
            assert.equal(rows[0].correlation_id, "frozen-steer")
            assert(rows[0].consumed_seq !== null)
            assert.equal(rows[1].correlation_id, "future-steer")
            assert.equal(rows[1].consumed_seq, null)
            assert.deepEqual(
              (yield* GoalTickCheckpoint.read(db, projected.permit_id))!.journal.parent.steering,
              checkpoint.journal.parent.steering,
            )
          }
        }
      }
      return {
        checkpoint: yield* GoalTickCheckpoint.read(db, tick.permit.permit_id),
        units: yield* db.all("SELECT * FROM goal_child_unit"),
        inputs: yield* db.all("SELECT * FROM session_input"),
        receipts: yield* db.all("SELECT * FROM session_v2_provider_turn_receipt"),
      }
    }),
  )
  await Bun.write(
    path.join(root, "result.json"),
    JSON.stringify({ pid: process.pid, requests: requests.length, result }, null, 2),
  )
} finally {
  await listener?.stop(true)
  provider.closeAllConnections()
  await new Promise<void>((resolve) => provider.close(() => resolve()))
}
process.exit(0)
