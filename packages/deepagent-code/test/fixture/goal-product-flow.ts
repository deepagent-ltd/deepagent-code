// Actual product Manager/Event/Session coordinator and file DB; only model transport is controlled.
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createServer } from "node:http"
import { Effect, Schema } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { GoalChild } from "@deepagent-code/core/deepagent/goal-child"
import { GoalControl } from "@deepagent-code/core/deepagent/goal-control"
import { GoalPlanRebaseSchema } from "@deepagent-code/core/deepagent/goal-plan-rebase.schema"
import { GoalTickCheckpointV2 } from "@deepagent-code/core/deepagent/goal-tick-checkpoint-v2"
import { GoalTickState } from "@deepagent-code/core/deepagent/goal-tick-state"
import { DeepAgentPlanStore } from "@deepagent-code/core/deepagent/plan-store"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { AppRuntime } from "@/effect/app-runtime"
import { GoalManager } from "@/session/goal-manager"
import { GoalTickProjection } from "@/session/goal-tick-projection"
import { Server } from "@/server/server"

const root = process.argv[2]!
const scenario = process.argv[3]!
const directory = path.join(root, "project")
const state: {
  listener?: Awaited<ReturnType<typeof Server.listen>>
  rebase?: GoalPlanRebaseSchema.Response
  requests: Array<{ receiptID: string; unitID: string; kind: string; stage: string; tick: number; turn: number }>
  waiting: Map<string, PromiseWithResolvers<void>>
  sockets: Set<import("node:net").Socket>
} = { requests: [], waiting: new Map(), sockets: new Set() }

const http = async (suffix: string, payload: object, method = "POST", expected: 200 | "rejected" = 200) => {
  assert(state.listener)
  const url = new URL(`/deepagent/goal${suffix}`, state.listener.url)
  url.searchParams.set("directory", directory)
  if (method === "GET") Object.entries(payload).forEach(([key, value]) => url.searchParams.set(key, String(value)))
  const response = await fetch(url, {
    method,
    headers: { authorization: `Basic ${Buffer.from("deepagent-code:goal-product-fixture").toString("base64")}`, "content-type": "application/json" },
    ...(method === "GET" ? {} : { body: JSON.stringify(payload) }),
  })
  const body: unknown = await response.json()
  if (expected === "rejected") assert.notEqual(response.status, 200, JSON.stringify(body))
  if (expected === 200) assert.equal(response.status, 200, JSON.stringify(body))
  return body
}
const rebaseHTTP = async (suffix: string, payload: object, method = "POST") =>
  Schema.decodeUnknownSync(GoalPlanRebaseSchema.Response)(await http(`/plan-rebase${suffix}`, payload, method))

const provider = createServer(async (request, response) => {
  const failure = async () => {
    assert.equal(request.url, "/v1/chat/completions")
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString())
    await Bun.write(path.join(root, `provider-${state.requests.length + 1}.json`), JSON.stringify(body))
    const actual = await AppRuntime.runPromise(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const receipt = (yield* db.all<{ receipt_id: string; session_id: string; user_message_id: string; provider_turn_seq: number }>(
        "SELECT receipt_id,session_id,user_message_id,provider_turn_seq FROM session_v2_provider_turn_receipt WHERE state IN ('dispatching','streaming') ORDER BY rowid DESC LIMIT 1",
      ))[0]
      assert(receipt, "Transport must follow a real dispatching provider receipt")
      const row = (yield* db.all<{ unit_id: string }>(sql`SELECT unit_id FROM goal_child_unit WHERE child_session_id=${receipt.session_id}`))[0]
      const unit = (yield* GoalChild.read(db, row.unit_id))!
      assert(unit.binding.version !== 1)
      const input = unit.inputs.find((item) => item.inputID === receipt.user_message_id)!
      assert(input?.execution, "Provider must be owned by an actual Goal input execution")
      const checkpoint = (yield* GoalTickCheckpointV2.read(db, unit.permit_id))!
      return { receiptID: receipt.receipt_id, unitID: unit.unit_id, kind: unit.binding.policy.role.kind,
        stage: input.stage, tick: checkpoint.tick_seq, turn: receipt.provider_turn_seq, goalID: unit.goal_id, parentSessionID: unit.parent_session_id }
    }))
    state.requests.push(actual)
    if (scenario === "rebase" && state.requests.length === 1) {
      const goal = await AppRuntime.runPromise(Effect.gen(function* () {
        return (yield* GoalControl.get((yield* Database.Service).db, actual.goalID))!
      }))
      state.rebase = await rebaseHTTP("/begin", { sessionID: goal.session_id, goalID: goal.goal_id,
        expectedControlRevision: goal.revision, requestID: "rebase-live-provider" })
      assert.equal(state.rebase.current.state, "waiting_boundary")
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    const emit = (value: object) => response.write(`data: ${JSON.stringify({ id: `goal-product-${state.requests.length}`, object: "chat.completion.chunk", created: 1, model: "test-model", ...value })}\n\n`)
    if (scenario === "control") {
      emit({ choices: [{ index: 0, delta: { role: "assistant", content: "An actual partial provider observation" } }] })
      const waiting = state.waiting.get(actual.parentSessionID)
      assert(waiting)
      waiting.resolve()
      return
    }
    const proposal = actual.kind === "worker" && actual.turn === 1
      ? await AppRuntime.runPromise(Effect.gen(function* () {
          const unit = (yield* GoalChild.read((yield* Database.Service).db, actual.unitID))!
          const plan = DeepAgentPlanStore.readExactPlan(unit.child_session_id, `doc:plan:plan-${unit.child_session_id}`)
          assert(plan.plan && plan.doc)
          return { operation: "advance", expected_plan_id: plan.plan.plan_id, expected_version: plan.doc.version,
            steps: plan.plan.steps.map((step) => ({ step_id: step.step_id, status: step.status === "active" ? "done" : step.status })), active_step_id: null }
        }))
      : undefined
    const invalid = scenario === "roles" && actual.tick === 0 && actual.kind === "reviewer" && actual.stage === "finalizer.1"
    emit({ choices: [{ index: 0, delta: { role: "assistant", ...(proposal
      ? { tool_calls: [{ index: 0, id: `call_product_plan_${actual.tick}`, type: "function", function: { name: "plan", arguments: JSON.stringify(proposal) } }] }
      : { content: invalid ? '{"verdict":"invalid"}' : '{"findings":[],"verdict":"approve"}' }) } }] })
    emit({ choices: [{ index: 0, delta: {}, finish_reason: proposal ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30,
        prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } })
    response.end("data: [DONE]\n\n")
  }
  void failure().catch(async (error: unknown) => {
    await Bun.write(path.join(root, "peer-error.log"), String(error))
    response.destroy(error instanceof Error ? error : new Error(String(error)))
  })
})
provider.on("connection", (socket) => { state.sockets.add(socket); socket.on("close", () => state.sockets.delete(socket)) })
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve))
const address = provider.address()
assert(address && typeof address !== "string")
await Bun.write(path.join(directory, "deepagent-code.json"), JSON.stringify({
  formatter: false, lsp: false, model: "fixture/test-model", permission: { "*": "allow" },
  provider: { fixture: { name: "Goal product transport", npm: "@ai-sdk/openai-compatible", env: [],
    options: { apiKey: "private-fixture", baseURL: `http://127.0.0.1:${address.port}/v1` },
    models: { "test-model": { name: "Fixture", tool_call: true, limit: { context: 100000, output: 10000 }, cost: { input: 0, output: 0 } } } } },
}))
await fs.mkdir(path.join(directory, ".deepagent-code/plans"), { recursive: true })
await Bun.write(path.join(directory, ".deepagent-code/plans/goal+plan.md"), "## Goal\nVerify two actual product steps\n## Criteria\n- plan complete\n- reviewer clean\n- panel approves\n## Plan\n- [>] First checked step\n- [ ] Second checked step\n")
const bin = path.join(root, "home/.deepagent/code/cache/bin")
await fs.mkdir(bin, { recursive: true })
await fs.copyFile(Bun.which("rg")!, path.join(bin, "rg"))

const wait = <A>(read: () => Promise<A>, accept: (value: A) => boolean, reason: string) =>
  Effect.gen(function* () {
    for (const attempt of Array.from({ length: 2000 }, (_, index) => index)) {
      const value = yield* Effect.promise(read)
      if (accept(value)) return value
      if (attempt === 1999) throw new Error(`Product boundary did not arrive: ${reason}`)
      yield* Effect.sleep("10 millis")
    }
    throw new Error(reason)
  })

const snapshot = () => AppRuntime.runPromise(Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const ids = yield* db.all<{ permit_id: string }>("SELECT permit_id FROM goal_tick_checkpoint ORDER BY tick_seq")
  const checkpoints = yield* Effect.forEach(ids, (item) => GoalTickCheckpointV2.read(db, item.permit_id))
  return { checkpoints: checkpoints.filter((item) => item !== undefined),
    permits: yield* db.all<{ goal_id: string; state: string; permit_id: string }>("SELECT * FROM goal_tick_permit"),
    units: yield* db.all("SELECT * FROM goal_child_unit"),
    receipts: yield* db.all<{ receipt_id: string; state: string; error_code: string; outcome_hash: string | null }>("SELECT * FROM session_v2_provider_turn_receipt"),
    inputs: yield* db.all("SELECT * FROM session_input"), active: Array.from(yield* (yield* SessionExecution.Service).active) }
}))

const start = () => AppRuntime.runPromise(Effect.gen(function* () {
  const sessions = yield* SessionV2.Service
  const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) },
    model: { providerID: ProviderV2.ID.make("fixture"), id: ModelV2.ID.make("test-model") },
    permissions: [{ action: "*", resource: "*", effect: "allow" }] })
  const manager = yield* GoalManager.Service
  const receipt = yield* manager.start({ sessionID: session.id, requestID: "goal-product-start",
    limits: { maxTicks: 3, maxTokens: 30000, maxWallclockMs: 60000 },
    panelQuestion: { question: "Are both checked steps safe to accept?", codeRefs: [], lenses: ["correctness", "security", "architecture"], maxRounds: 2 } })
  return { session, receipt }
}))

const cleanup = { listenerClosed: false, providerClosed: false, runtimeDisposed: false }
try {
  await AppRuntime.runPromise(Database.Service)
  state.listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  if (scenario === "control") {
    const controls = []
    for (const action of ["pause", "stop"] as const) {
      // Install the signal before manager dispatch: the actual peer follows the original event chain.
      const signal = Promise.withResolvers<void>()
      const session = await AppRuntime.runPromise(SessionV2.Service.use((sessions) => sessions.create({
        location: { directory: AbsolutePath.make(directory) }, model: { providerID: ProviderV2.ID.make("fixture"), id: ModelV2.ID.make("test-model") },
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      })))
      state.waiting.set(session.id, signal)
      const preparing = AppRuntime.runPromise(GoalManager.Service.use((manager) => manager.start({
        sessionID: session.id, requestID: `control-start-${action}`, objective: "Control an in-flight actual provider",
        criteria: [{ kind: "reviewer_clean", maxSeverity: "high" }, { kind: "panel_approves" }],
        limits: { maxTicks: 3, maxTokens: 30000, maxWallclockMs: 60000 },
      })))
      await preparing
      await signal.promise
      const goal = await AppRuntime.runPromise(Effect.gen(function* () {
        return (yield* GoalControl.current((yield* Database.Service).db, session.id))!
      }))
      const before = await snapshot()
      assert.equal(before.active.length, 1)
      await http(`/${action}`, { sessionID: session.id, goalId: goal.goal_id, expectedRevision: goal.revision, requestID: `in-flight-${action}` })
      const after = await AppRuntime.runPromise(wait(snapshot, (item) => item.active.length === 0 &&
        item.permits.find((row) => row.goal_id === goal.goal_id)?.state === "unknown", "owned interruption settles and retains unknown permit"))
      const checkpoint = after.checkpoints.find((item) => item.goal_id === goal.goal_id)!
      const permit = after.permits.find((item) => item.goal_id === goal.goal_id)!
      assert.equal(checkpoint.state, "recovery_required")
      assert.equal(checkpoint.journal.results.length, 0)
      assert.equal(checkpoint.journal.documents.length, 0)
      assert.equal(checkpoint.journal.localEffects.length, 0)
      assert.equal(permit.state, "unknown")
      const receipt = after.receipts.find((item) => item.receipt_id === state.requests.at(-1)!.receiptID)!
      assert.equal(receipt.state, "indeterminate_after_crash")
      assert.equal(receipt.error_code, "consumer_cancelled_after_dispatch")
      assert.equal(receipt.outcome_hash, null)
      const count = state.requests.length
      await http("/status", { sessionID: session.id }, "GET")
      await http("/startable", { sessionID: session.id }, "GET")
      const rejected = await http("/resume", { sessionID: session.id, goalId: goal.goal_id,
        expectedRevision: goal.revision + 1, requestID: `refuse-unknown-resume-${action}` }, "POST", "rejected")
      assert(JSON.stringify(rejected).includes(action === "pause" ? "recovery_required" : "target_conflict"))
      assert.equal(state.requests.length, count)
      const observed = await snapshot()
      assert.deepEqual(observed.receipts, after.receipts)
      assert.deepEqual(observed.inputs, after.inputs)
      assert.deepEqual(observed.units, after.units)
      assert.deepEqual(observed.checkpoints, after.checkpoints)
      controls.push({ action, requests: count - controls.length, checkpointState: checkpoint.state, permitState: permit.state })
    }
    await Bun.write(path.join(root, "result.json"), JSON.stringify({ scenario, controls, requests: state.requests.length, cleanup }))
  } else {
    const started = await start()
    if (scenario === "rebase") {
      const first = await AppRuntime.runPromise(wait(snapshot, (item) => item.checkpoints[0]?.state === "committed", "safe first tick"))
      assert(state.rebase)
      const ready = await rebaseHTTP(`/${state.rebase.current.editID}`, { sessionID: started.session.id,
        goalID: started.receipt.goalId, requestID: "rebase-live-provider" }, "GET")
      assert.equal(ready.current.state, "ready")
      assert(ready.current.editSource)
      const plan = DeepAgentPlanStore.decodePlanDoc(ready.current.editSource.planDocument.body)!
      assert.equal(plan.steps[0].status, "done")
      const applied = await rebaseHTTP("/apply", { sessionID: started.session.id, goalID: started.receipt.goalId,
        editID: ready.current.editID, requestID: "apply-operator-plan", expectedEditRevision: ready.current.revision,
        expectedControlRevision: ready.current.controlRevision, expectedPlanRevision: ready.current.planRevision,
        expectedDocVersion: ready.current.editSource.planDocument.version, expectedDocHash: ready.current.editSource.planDocHash,
        candidate: { steps: plan.steps.map((item, index) => index === 1 ? { ...item, title: "Operator revised second step" } : item),
          activeStepID: plan.active_step_id, dispositions: [{ stepID: plan.steps[1].step_id, reason: "Retain the next step and its original identity" }] },
        reason: "Clarify the remaining step after its predecessor was independently verified" })
      assert.equal(applied.current.state, "committed")
      assert.equal(applied.current.safeToResume, true)
      const beforeResume = await snapshot()
      assert.deepEqual(beforeResume.checkpoints, first.checkpoints)
      assert.deepEqual(beforeResume.receipts, first.receipts)
      assert.equal(beforeResume.checkpoints.length, 1)
      await http("/status", { sessionID: started.session.id }, "GET")
      await rebaseHTTP(`/${ready.current.editID}`, { sessionID: started.session.id, goalID: started.receipt.goalId, requestID: "apply-operator-plan" }, "GET")
      assert.deepEqual((await snapshot()).receipts, beforeResume.receipts)
      await http("/resume", { sessionID: started.session.id, goalId: started.receipt.goalId,
        expectedRevision: applied.current.controlRevision, requestID: "operator-explicit-resume" })
      state.rebase = applied
    }
    const final = await AppRuntime.runPromise(wait(snapshot, (item) => item.checkpoints.length === 2 && item.checkpoints.every((row) => row.state === "committed") && item.active.length === 0, "two actual event-driven ticks"))
    const checkpoint = final.checkpoints.at(-1)!
    const cursor = Schema.decodeUnknownSync(Schema.fromJsonString(GoalTickState.Runtime))(checkpoint.journal.nextState)
    assert.equal(cursor.phase, "done")
    const plan = GoalTickProjection.readPlan(GoalManager.goalStoreRoot(started.session.id), started.session.id)!.plan
    const results = final.checkpoints.flatMap((item) => item.journal.results)
    const ledger = { providerCount: results.reduce((count, item) => count + item.providers.count, 0),
      input: results.reduce((count, item) => count + item.usage.input, 0), output: results.reduce((count, item) => count + item.usage.output, 0) }
    assert.equal(ledger.providerCount, state.requests.length)
    assert.equal(ledger.input, state.requests.length * 20)
    assert.equal(ledger.output, state.requests.length * 10)
    assert.equal(cursor.ledger.tokens, ledger.input + ledger.output)
    assert(final.permits.every((item) => item.state === "settled"))
    assert(results.every((item) => item.providers.count > 0))
    const first = final.checkpoints[0]
    const payload = { scenario, requests: state.requests.length, phase: cursor.phase, plan, checkpoints: final.checkpoints,
      active: final.active, ledger, roles: [...new Set(final.checkpoints.flatMap((item) => item.journal.program.roles.map((role) => role.kind)))].sort(),
      invalidFinalizers: results.filter((item) => item.outcome === "schema_invalid").length,
      secondFinalizers: results.filter((item) => item.stage === "finalizer.2").length,
      skippedPanels: final.checkpoints.reduce((count, item) => count + item.journal.dispositions.filter((entry) => entry.kind === "skipped" && item.journal.program.roles[entry.role].kind === "panel").length, 0),
      ...(scenario === "rebase" ? { rebase: { beginState: "waiting_boundary", appliedState: state.rebase!.current.state,
        planRevision: state.rebase!.current.planRevision, firstCheckpointUnchanged: true, noExecutionBeforeResume: true,
        receiptHash: state.rebase!.originalReceipt!.committedReceiptHash,
        lineage: checkpoint.journal.program.version === 3 ? checkpoint.journal.program.planLineage.sourceReceiptHash : null,
        previousCheckpointHash: first.journal_hash } } : {}), cleanup }
    await Bun.write(path.join(root, "result.json"), JSON.stringify(payload))
  }
} finally {
  await state.listener?.stop()
  cleanup.listenerClosed = true
  state.sockets.forEach((socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()))
  cleanup.providerClosed = true
  await AppRuntime.dispose()
  cleanup.runtimeDisposed = true
  if (await Bun.file(path.join(root, "result.json")).exists()) {
    const result = await Bun.file(path.join(root, "result.json")).json()
    await Bun.write(path.join(root, "result.json"), JSON.stringify({ ...result, cleanup }))
  }
}
process.exit(0)
