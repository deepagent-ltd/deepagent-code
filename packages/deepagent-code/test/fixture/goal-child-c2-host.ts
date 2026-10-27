// Actual AppRuntime/Location/SessionRunner. Only the loopback provider response is deterministic.
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { writeFileSync, writeSync } from "node:fs"
import path from "node:path"
import { createServer } from "node:http"
import net from "node:net"
import { Cause, DateTime, Effect, Exit, Fiber, Schema } from "effect"
import { sql } from "drizzle-orm"
import { AgentV2 } from "@deepagent-code/core/agent"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
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
import { PermissionV2 } from "@deepagent-code/core/permission"
import { Policy } from "@deepagent-code/core/policy"
import { ServerCapabilities } from "@deepagent-code/core/server-capabilities"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionMessage } from "@deepagent-code/core/session/message"
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
const observed = ["loop", "loop-failed", "steer-valid", "loop-stop", "loop-proposal-two",
  "loop-proposal-diagnostics-stale", "loop-cold", "loop-cold-recover", "loop-proposal-two-cold",
  "loop-proposal-two-recover"].includes(scenario)
const stage = (event: string, details?: Record<string, unknown>) => {
  if (!observed) return
  writeSync(2, `[goal-c2-fixture] ${JSON.stringify({
    scenario, event, at: Date.now(), elapsedMs: Math.round(performance.now()), ...details,
  })}\n`)
}
import { GoalTickProgram } from "@deepagent-code/core/deepagent/goal-tick-program"
import { GoalTickCheckpointV2 } from "@deepagent-code/core/deepagent/goal-tick-checkpoint-v2"
import { GoalTickExecution } from "@/session/goal-tick-execution"
import { GoalOwnedTurn } from "@/session/goal-owned-turn"
import { OwnedValidation } from "@/deepagent/owned-validation"
import { GoalTickProjection } from "@/session/goal-tick-projection"
import { GoalManager } from "@/session/goal-manager"
import { GoalOwnedLoop } from "@/session/goal-owned-loop"
import { GoalPlanRebase } from "@deepagent-code/core/deepagent/goal-plan-rebase"
import { GoalPlanRebaseSchema } from "@deepagent-code/core/deepagent/goal-plan-rebase.schema"
import { DeepAgentPlanStore } from "@deepagent-code/core/deepagent/plan-store"
import { createPlanDoc } from "@deepagent-code/core/deepagent/plan-controller"
const requests: unknown[] = []
const firstProviderRequest = Promise.withResolvers<void>()
stage("fixture-module-loaded")
let rebaseBegin: GoalPlanRebaseSchema.Response | undefined
let rebaseControl: Promise<unknown> | undefined
const goalControlHTTP = async (action: "stop" | "pause", payload: object) => {
  assert(listener)
  const url = new URL(`/deepagent/goal/${action}`, listener.url)
  url.searchParams.set("directory", directory)
  const response = await fetch(url, { method: "POST", headers: { authorization: `Basic ${Buffer.from("deepagent-code:goal-rebase-fixture").toString("base64")}`, "content-type": "application/json" }, body: JSON.stringify(payload) })
  const body: unknown = await response.json()
  assert.equal(response.status, 200, JSON.stringify(body))
  return body
}
const rebaseHTTP = async (suffix: string, payload: object, method = "POST") => {
  assert(listener)
  const url = new URL(`/deepagent/goal/plan-rebase${suffix}`, listener.url)
  url.searchParams.set("directory", directory)
  if (method === "GET") Object.entries(payload).forEach(([key, value]) => url.searchParams.set(key, String(value)))
  const response = await fetch(url, { method, headers: { authorization: `Basic ${Buffer.from("deepagent-code:goal-rebase-fixture").toString("base64")}`, "content-type": "application/json" }, ...(method === "GET" ? {} : { body: JSON.stringify(payload) }) })
  const body: unknown = await response.json()
  assert.equal(response.status, 200, JSON.stringify(body))
  return Schema.decodeUnknownSync(GoalPlanRebaseSchema.Response)(body)
}
const provider = createServer(async (request, response) => {
  assert.equal(request.url, scenario === "anthropic" ? "/v1/messages" : "/v1/chat/completions")
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  requests.push(JSON.parse(Buffer.concat(chunks).toString()))
  firstProviderRequest.resolve()
  stage("provider-request-observed", { requests: requests.length })
  await Bun.write(path.join(root, "provider.json"), JSON.stringify(requests))
  if (scenario.startsWith("loop-proposal-two-rebase") && requests.length === 1) {
    const goal = await AppRuntime.runPromise(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const row = (yield* db.all<{ goal_id: string }>("SELECT goal_id FROM goal_control WHERE is_current=1"))[0]
      return (yield* GoalControl.get(db, row.goal_id))!
    }))
    if (scenario.endsWith("-clients")) {
      assert(listener)
      const url = new URL("/deepagent/goal/plan-rebase/begin", listener.url)
      url.searchParams.set("directory", directory)
      const authorization = `Basic ${Buffer.from("deepagent-code:goal-rebase-fixture").toString("base64")}`
      const body = { sessionID: goal.session_id, goalID: goal.goal_id, expectedControlRevision: goal.revision, requestID: "scope-negative" }
      for (const probe of [
        { headers: {}, body: { ...body, operator: "claimed-human", capability: { trusted: true } } },
        { headers: { authorization: `Basic ${Buffer.from("deepagent-code:wrong").toString("base64")}` }, body },
        { headers: { authorization, origin: "http://127.0.0.1:1" }, body },
        { headers: { authorization }, body: { ...body, sessionID: "ses_different_scope" } },
        { headers: { authorization }, body: { ...body, goalID: "goal_different_scope" } },
      ]) {
        const headers = new Headers({ "content-type": "application/json" })
        Object.entries(probe.headers).forEach(([key, value]) => { if (value !== undefined) headers.set(key, value) })
        const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(probe.body) })
        assert.notEqual(response.status, 200)
        await response.arrayBuffer()
      }
      await AppRuntime.runPromise(Effect.gen(function* () {
        const db = (yield* Database.Service).db
        assert.deepEqual(yield* db.all("SELECT * FROM goal_plan_rebase"), [])
        assert.equal((yield* db.all("SELECT * FROM goal_control_command")).length, 1)
      }))
    }
    rebaseBegin = await rebaseHTTP("/begin", { sessionID: goal.session_id, goalID: goal.goal_id,
      expectedControlRevision: goal.revision, requestID: "rebase-during-provider" })
    assert.equal(rebaseBegin.current.state, "waiting_boundary")
    assert.equal(rebaseBegin.current.controlRevision, goal.revision)
    if (scenario.endsWith("-stop-boundary") || scenario.endsWith("-cancel-boundary")) {
      rebaseControl = scenario.endsWith("-cancel-boundary")
        ? rebaseHTTP("/cancel", { sessionID: goal.session_id, goalID: goal.goal_id, editID: rebaseBegin.current.editID,
            expectedControlRevision: goal.revision, expectedEditRevision: rebaseBegin.current.revision, requestID: "cancel-during-rebase-boundary" })
        : goalControlHTTP("stop", { sessionID: goal.session_id, goalId: goal.goal_id,
            expectedRevision: goal.revision, requestID: "stop-during-rebase-boundary" })
      await rebaseControl
    }
  }
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
  const isProposal =
    scenario.startsWith("loop-proposal") &&
    (requests.length === 1 || (scenario.startsWith("loop-proposal-two") && requests.length === 5))
  const proposal = isProposal
    ? await AppRuntime.runPromise(
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const row = (yield* db.all<{ child_session_id: string }>(
            "SELECT child_session_id FROM goal_child_unit ORDER BY rowid DESC LIMIT 1",
          ))[0]
          const plan = DeepAgentPlanStore.readExactPlan(row.child_session_id, `doc:plan:plan-${row.child_session_id}`)
          assert(plan.plan && plan.doc)
          return {
            operation: "advance",
            expected_plan_id: plan.plan.plan_id,
            expected_version: plan.doc.version,
            steps: plan.plan.steps.map((step) => ({
              step_id: step.step_id,
              status:
                scenario.startsWith("loop-proposal-two") &&
                scenario !== "loop-proposal-two-broad" &&
                step.status !== "active"
                  ? step.status
                  : "done",
            })),
            active_step_id: null,
          }
        }),
      )
    : undefined
  if (scenario === "loop-proposal-mutated" && requests.length === 2) {
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const row = (yield* db.all<{ child_session_id: string }>("SELECT child_session_id FROM goal_child_unit"))[0]
        const value = DeepAgentPlanStore.readExactPlan(row.child_session_id, `doc:plan:plan-${row.child_session_id}`)
        value.documentStore.update(value.doc!.id, value.doc!.body + " ")
      }),
    )
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
          ...((scenario === "plan" && requests.length === 1) || isProposal
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_c2_plan",
                    type: "function",
                    function: {
                      name: "plan",
                      arguments: JSON.stringify(
                        proposal ?? {
                          operation: "create",
                          expected_plan_id: null,
                          expected_version: null,
                          goal: "Owned scratch",
                          steps: [{ title: "Verify", status: "active" }],
                        },
                      ),
                    },
                  },
                ],
              }
            : {
                content:
                  scenario.startsWith("loop") || scenario.startsWith("manager")
                    ? '{"findings":[],"verdict":"approve"}'
                    : scenario === "structured" && requests.length === 3
                      ? '{"ok":true}'
                      : "known stage result",
              }),
        },
      },
    ],
  })
  if (scenario === "loop-stop") return
  emit({
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: (scenario === "plan" && requests.length === 1) || isProposal ? "tool_calls" : "stop",
      },
    ],
    ...(scenario === "missing-usage" ||
    scenario === "loop-missing-usage" ||
    (scenario === "loop-proposal-two-unknown" && requests.length === 2)
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
    lsp: scenario.startsWith("loop-proposal-diagnostics")
      ? {
          "owned-fixture": {
            command: [
              process.execPath,
              path.resolve(import.meta.dir, "../lsp/fixture/owned-diagnostics-server.ts"),
              scenario.endsWith("stale") ? "stale" : "pull",
            ],
            extensions: [".ts"],
          },
        }
      : false,
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
if (scenario.startsWith("loop-proposal-diagnostics"))
  await Bun.write(path.join(directory, "code.ts"), "const checked = 1\n")
const rg = Bun.which("rg")!
const bin = path.join(root, "home/.deepagent/code/cache/bin")
await fs.mkdir(bin, { recursive: true })
await fs.copyFile(rg, path.join(bin, "rg"))
let listener: Awaited<ReturnType<typeof Server.listen>> | undefined
try {
  stage("runtime-build-started")
  if (scenario !== "loop-cold-recover" && scenario !== "loop-proposal-two-recover" && !scenario.startsWith("loop-proposal-two-rebase-recover"))
    await AppRuntime.runPromise(WorkAuthorityFixture.initialize())
  else await AppRuntime.runPromise(Database.Service)
  stage("runtime-ready")
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
  const port = probe.address()
  assert(port && typeof port !== "string")
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  listener = await Server.listen({ hostname: "127.0.0.1", port: port.port })
  stage("listener-ready")
  const result = await AppRuntime.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      if (scenario.startsWith("loop-proposal-two-rebase-recover")) {
        const request = Schema.decodeUnknownSync(GoalPlanRebaseSchema.Apply)(yield* Effect.promise(() => Bun.file(path.join(root, "rebase-request.json")).json()))
        const inputs = yield* db.all("SELECT * FROM session_input")
        const checkpoints = yield* db.all("SELECT * FROM goal_tick_checkpoint")
        if (scenario.endsWith("-stop")) {
          const goal = (yield* GoalControl.get(db, request.goalID))!
          const before = (yield* GoalPlanRebase.read(db, request.editID))!
          const mirrors = before.journal.source!.documents.map((item) => DocumentStore.openExact(GoalManager.goalStoreRoot(request.sessionID), [item.id]).get(item.id)!.hash)
          yield* Effect.promise(() => goalControlHTTP("stop", { sessionID: request.sessionID, goalId: request.goalID,
            expectedRevision: goal.revision, requestID: "stop-after-first-file-unknown" }))
          const stopped = (yield* GoalPlanRebase.read(db, request.editID))!
          assert.equal(stopped.state, "recovery_required")
          assert.equal(stopped.journal.fileStarted, true)
          assert.equal(stopped.journal.documents.filter((item) => item.state === "confirmed").length, 0)
          assert.deepEqual(stopped.journal.source!.documents.map((item) => DocumentStore.openExact(GoalManager.goalStoreRoot(request.sessionID), [item.id]).get(item.id)!.hash), mirrors)
        }
        const journals = yield* db.all("SELECT * FROM goal_plan_rebase")
        const current = yield* Effect.promise(() => rebaseHTTP(`/${request.editID}`, {
          sessionID: request.sessionID, goalID: request.goalID, requestID: request.requestID }, "GET"))
        assert.deepEqual(yield* db.all("SELECT * FROM goal_plan_rebase"), journals)
        assert.equal(requests.length, 0)
        const cut = yield* Effect.promise(() => Bun.file(path.join(root, "cold-window.json")).json())
        assert.equal(current.current.partial, ["file1", "file2", "file3"].includes(cut.window))
        assert.equal(current.current.safeToResume, cut.window === "commit" && !scenario.endsWith("-stop"))
        if (scenario.endsWith("-stop")) assert.equal(current.current.execution, "blocked")
        if (cut.window === "file1") assert.equal(current.current.confirmedDocuments, 0)
        const result = current.current.state === "committed"
          ? yield* Effect.promise(() => rebaseHTTP("/apply", request))
          : yield* Effect.promise(() => rebaseHTTP(`/${request.editID}/reconcile`, { sessionID: request.sessionID,
              goalID: request.goalID, editID: request.editID, requestID: "rebase-cold-reconcile",
              expectedEditRevision: current.current.revision, expectedControlRevision: current.current.controlRevision }))
        assert.equal(result.current.state, "committed")
        assert.equal(result.current.safeToResume, !scenario.endsWith("-stop"))
        assert.equal(requests.length, 0)
        assert.deepEqual(yield* db.all("SELECT * FROM session_input"), inputs)
        assert.deepEqual(yield* db.all("SELECT * FROM goal_tick_checkpoint"), checkpoints)
        assert.equal((yield* GoalControl.get(db, request.goalID))!.requested_phase, scenario.endsWith("-stop") ? "stopped" : "paused")
        return { receipt: result, inputs, checkpoints, active: Array.from(yield* (yield* SessionExecution.Service).active) }
      }
      if (scenario === "loop-cold-recover" || scenario === "loop-proposal-two-recover") {
        const source = (yield* db.all<{ permit_id: string; session_id: string }>(
          "SELECT c.permit_id,g.session_id FROM goal_tick_checkpoint c JOIN goal_control g ON g.goal_id=c.goal_id",
        ))[0]
        const before = yield* db.all("SELECT id FROM session_input")
        const complete = yield* GoalOwnedLoop.project({
          permitID: source.permit_id,
          directory: DeepAgentPlanStore.planStoreRoot(source.session_id),
        })
        assert.equal(complete.state, "committed")
        assert.deepEqual(yield* db.all("SELECT id FROM session_input"), before)
        assert.equal(requests.length, 0)
        return {
          checkpoint: complete,
          inputs: before,
          units: yield* db.all("SELECT * FROM goal_child_unit"),
          active: Array.from(yield* (yield* SessionExecution.Service).active),
        }
      }
      const parent = yield* sessions.create({
        location: { directory: AbsolutePath.make(directory) },
        model: { providerID: ProviderV2.ID.make("fixture"), id: ModelV2.ID.make("test-model") },
        permissions: [
          { action: "*", resource: "*", effect: "allow" },
          ...(scenario === "validation-deny" ? [{ action: "bash", resource: "*", effect: "deny" as const }] : []),
          ...(scenario.startsWith("validation-ask-")
            ? [{ action: "bash", resource: "*", effect: "ask" as const }]
            : []),
          ...(scenario === "validation-external-deny"
            ? [{ action: "external_directory", resource: "*", effect: "deny" as const }]
            : []),
        ],
      })
      if (scenario.startsWith("initial-selection-")) {
        const docroot = GoalManager.goalStoreRoot(parent.id)
        const file = path.join(directory, ".deepagent-code/plans/goal+plan.md")
        const markdown = `## Goal\nVerify the authored steps\n## Criteria\n- plan complete\n## Plan\n${
          scenario === "initial-selection-active"
            ? "- [>] Verify first\n- [ ] Verify second\n"
            : scenario === "initial-selection-done"
              ? "- [x] Verify first\n- [x] Verify second\n"
              : "- [ ] Verify first\n- [ ] Verify second\n"
        }`
        yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
        yield* Effect.promise(() => Bun.write(file, markdown))
        const selected = GoalManager.readGoalPlanFile(directory, parent.id)!
        assert(selected)
        const original = JSON.stringify(selected.plan)
        const prior =
          scenario === "initial-selection-markdown"
            ? undefined
            : new DocumentStore(docroot).create({
                type: "plan",
                scope: `run:${parent.id}`,
                idSlug: `plan-${parent.id}`,
                description: "Authored initial plan",
                body: original,
                provenance: { source: "human", run_ref: `run:${parent.id}` },
              })
        const start = { sessionID: parent.id, requestID: scenario, planSource: "workspace-file" as const }
        const options = {
          directory: docroot,
          sessionID: parent.id,
          requestID: start.requestID,
          plan: selected.plan,
          spec: {
            criteria: selected.criteria,
            limits: { maxTicks: 3, maxTokens: 1000, maxWallclockMs: 60000 },
            stallThreshold: 3,
          },
          model: { providerID: "fixture", modelID: "test-model" },
          netTokenBudget: false,
          panel: { question: "Review", codeRefs: [], lenses: ["correctness"], maxRounds: 1 },
        }
        if (scenario === "initial-selection-source-conflict") {
          const refused = yield* GoalTickProjection.prepare(db, {
            ...options,
            plan: { ...selected.plan, goal: "A different selected source" },
          }).pipe(Effect.exit)
          assert(Exit.isFailure(refused))
          assert(Cause.pretty(refused.cause).includes("The selected initial plan changed before preparation"))
          assert.equal(DocumentStore.openExact(docroot, [prior!.id]).get(prior!.id)!.hash, prior!.hash)
        } else {
          const initialization = yield* GoalTickProjection.prepare(db, options)
          const document = initialization.ownedPreparation!.documents[0]!
          const payload = Schema.decodeUnknownSync(Schema.fromJsonString(GoalTickProgram.DocumentPayload))(document.payload)
          const desired = DeepAgentPlanStore.decodePlanDoc(payload.body)!
          assert(desired)
          assert.equal(JSON.stringify(selected.plan), original, "Preparing must not mutate its authored input")
          assert.equal(yield* Effect.promise(() => Bun.file(file).text()), markdown)
          assert.equal(document.expectedVersion, prior?.version ?? null)
          assert.equal(document.expectedHash, prior?.hash.slice(7) ?? null)
          if (scenario === "initial-selection-active" || scenario === "initial-selection-done") {
            assert.equal(payload.body, original)
            assert.equal(payload.version, prior!.version)
          } else {
            assert.deepEqual(
              desired.steps.map((step) => step.status),
              ["active", "pending"],
            )
            assert.equal(desired.active_step_id, "step_1")
            assert.equal(payload.version, prior ? prior.version + 1 : 1)
            assert.deepEqual(
              { ...desired, steps: selected.plan.steps, active_step_id: selected.plan.active_step_id },
              selected.plan,
            )
          }
          if (prior) assert.deepEqual({ ...payload, body: prior.body, version: prior.version, hash: prior.hash }, prior)
          assert.equal(initialization.planVersion, payload.version)
          const request = {
            ...start,
            requestHash: GoalControl.fingerprint(start),
            planDocId: initialization.spec.planDocId,
            initialization,
            driverMode: "event" as const,
          }
          const reserved = yield* GoalControl.reserveStart(db, request)
          const input = {
            row: reserved.row,
            requestID: start.requestID,
            requestHash: request.requestHash,
            directory: docroot,
          }
          if (scenario === "initial-selection-cas-conflict") {
            const store = DocumentStore.openExact(docroot, [prior!.id])
            const competing = store.update(prior!.id, `${prior!.body} `)
            const refused = yield* GoalTickProjection.initialize(db, input).pipe(Effect.exit)
            assert(Exit.isFailure(refused))
            assert(Cause.pretty(refused.cause).includes("Exact initial Goal document bytes could not be confirmed"))
            assert.equal(DocumentStore.openExact(docroot, [prior!.id]).get(prior!.id)!.hash, competing.hash)
            assert.equal((yield* GoalControl.get(db, reserved.row.goal_id))!.preparation, "preparing")
            assert.deepEqual(yield* db.all("SELECT * FROM goal_tick_permit"), [])
          } else {
            if (scenario === "initial-selection-stored") {
              yield* db.run(
                sql`CREATE TRIGGER initial_selection_gap BEFORE UPDATE ON goal_control WHEN NEW.preparation='ready' BEGIN SELECT RAISE(ABORT,'fixture initialization gap'); END`,
              )
              assert(Exit.isFailure(yield* GoalTickProjection.initialize(db, input).pipe(Effect.exit)))
              assert.equal((yield* GoalControl.get(db, reserved.row.goal_id))!.preparation, "preparing")
              assert.equal(DocumentStore.openExact(docroot, [payload.id]).get(payload.id)!.version, payload.version)
              yield* db.run(sql`DROP TRIGGER initial_selection_gap`)
            }
            const receipt = yield* GoalTickProjection.initialize(db, input)
            const projected = DocumentStore.openExact(docroot, [payload.id]).get(payload.id)!
            assert.equal(projected.version, payload.version)
            assert.equal(projected.body, payload.body)
            const replay = yield* (yield* GoalManager.Service).start(start)
            assert.equal(replay.replayed, true)
            assert.equal(replay.goalId, receipt.goalId)
            assert.equal(replay.revision, receipt.revision)
            assert.equal(DocumentStore.openExact(docroot, [payload.id]).get(payload.id)!.hash, projected.hash)
            assert.deepEqual(yield* db.all("SELECT * FROM goal_tick_permit"), [])
            const tick = yield* GoalControl.beginTick(db, {
              sessionID: parent.id,
              goalId: receipt.goalId,
              planDocId: payload.id,
              revision: 1,
              seq: 0,
              expectedPlanVersion: initialization.planVersion,
              mode: "event",
            })
            const frozen = yield* GoalOwnedLoop.prepare({ permitID: tick.permit.permit_id, directory: docroot })
            assert.deepEqual(frozen.plan, desired)
            assert.equal(tick.permit.plan_version, payload.version)
          }
        }
        return {
          inputs: yield* db.all("SELECT * FROM session_input"),
          units: yield* db.all("SELECT * FROM goal_child_unit"),
          active: Array.from(yield* (yield* SessionExecution.Service).active),
        }
      }
      if (scenario.startsWith("manager")) {
        const statusEvents: Array<{ type: string; data: Record<string, unknown> }> = []
        const events = yield* EventV2Bridge.Service
        yield* events.listen((event) =>
          Effect.gen(function* () {
            if (event.type !== "goal.updated" && event.type !== "plan.updated") return
            statusEvents.push({ type: event.type, data: event.data as Record<string, unknown> })
            const ledger = (event.data as { ledger?: { ticks: number } }).ledger
            if (
              scenario === "manager-status-publish-failure" &&
              event.type === "goal.updated" &&
              ledger &&
              ledger.ticks > 0
            )
              return yield* Effect.die("Intentional status listener fault after committed checkpoint")
          }),
        )
        const manager = yield* GoalManager.Service
        const input = {
          sessionID: parent.id,
          requestID: "actual-manager-start",
          objective: "Verify the bounded actual Goal",
          limits: { maxTicks: 3, maxTokens: 1000, maxWallclockMs: 60000 },
          ...(scenario === "manager-tests"
            ? {
                criteria: [
                  { kind: "tests_pass" as const, commands: ["printf verified"] },
                  { kind: "reviewer_clean" as const, maxSeverity: "high" as const },
                ],
              }
            : {}),
        }
        const receipt = yield* manager.start(input)
        assert.equal((yield* GoalControl.get(db, receipt.goalId))!.initialization.executionContract, "owned-goal-v2")
        const editing = yield* manager
          .editPlan({
            sessionID: parent.id,
            requestID: "rebase-unavailable",
            planWrite: {
              operation: "advance",
              expected_plan_id: "unused",
              expected_version: 1,
              goal: "changed",
              steps: [],
            },
          })
          .pipe(Effect.exit)
        assert(Exit.isFailure(editing))
        assert(Cause.pretty(editing.cause).includes("authenticated plan-rebase begin/apply protocol"))
        const replay = yield* manager.start(input)
        assert(replay.replayed)
        assert.equal(receipt.goalId, replay.goalId)
        for (let n = 0; n < 3000; n++) {
          const status = yield* manager.status(parent.id)
          if (status && ["done", "needs_human"].includes(status.phase)) break
          if (scenario === "manager-tests" && process.platform !== "darwin" && status?.recoveryRequired) {
            const receipts = yield* db.all<{ last_error: string | null }>(
              "SELECT last_error FROM deepagent_consumer_receipt WHERE consumer_kind='goal_tick'",
            )
            if (receipts.some((row) => row.last_error === "Owned validation is unavailable")) break
          }
          if (n === 2999) throw new Error("Actual Manager event consumer did not reach a terminal state")
          yield* Effect.sleep("10 millis")
        }
        const row = (yield* db.all<{ permit_id: string }>("SELECT permit_id FROM goal_tick_checkpoint"))[0]
        const checkpoint = yield* GoalTickCheckpointV2.read(db, row.permit_id)
        if (scenario === "manager-tests" && process.platform !== "darwin") {
          const status = yield* manager.status(parent.id)
          assert(status?.recoveryRequired)
          assert(checkpoint)
          assert.equal(checkpoint.state, "recovery_required")
          assert.deepEqual(checkpoint.journal.localEffects, [])
          assert.equal(checkpoint.journal.nextState, null)
          assert.equal(requests.length, 1)
          const failures = yield* db.all<{ status: string; last_error: string | null }>(
            "SELECT status,last_error FROM deepagent_consumer_receipt WHERE consumer_kind='goal_tick'",
          )
          assert.deepEqual(failures, [{ status: "pending", last_error: "Owned validation is unavailable" }])
          assert.deepEqual(OwnedValidation.inspectCustody(), {
            limit: OwnedValidation.VALIDATION_CUSTODY_LIMIT, live: 0, quarantine: 0,
          })
          console.error(JSON.stringify({ probe: "manager-tests-native-refusal", phase: status.phase,
            recoveryRequired: status.recoveryRequired, checkpoint: checkpoint.state,
            localEffects: checkpoint.journal.localEffects.length, requests: requests.length, failures }))
          return {
            status, checkpoint, failures,
            inputs: yield* db.all("SELECT * FROM session_input"),
            units: yield* db.all("SELECT * FROM goal_child_unit"),
            active: Array.from(yield* (yield* SessionExecution.Service).active),
            validationCustody: OwnedValidation.inspectCustody(),
          }
        }
        assert.equal(checkpoint?.state, "committed")
        assert.equal((yield* manager.status(parent.id))!.phase, scenario === "manager-tests" ? "done" : "needs_human")
        if (scenario.startsWith("manager")) {
          for (
            let n = 0;
            n < 100 &&
            !statusEvents.some(
              (event) => event.type === "goal.updated" && (event.data.ledger as { ticks: number }).ticks > 0,
            );
            n++
          )
            yield* Effect.sleep("10 millis")
          const state = JSON.parse(checkpoint!.journal.nextState!)
          const observed = statusEvents.filter((event) => event.type === "goal.updated").at(-1)!
          assert.equal(observed.data.phase, state.phase, "Owned committed phase must reach existing status publisher")
          assert.deepEqual(observed.data.ledger, {
            ticks: state.ledger.ticks,
            tokens: state.ledger.tokens,
            cost: state.ledger.cost,
            wallclockMs: state.ledger.wallclockMs,
          })
          assert.deepEqual(observed.data.gaps, state.gaps)
          assert(state.ledger.ticks > 0 && state.ledger.tokens > 0)
          const plan = DocumentStore.shared(GoalManager.goalStoreRoot(parent.id)).get(receipt.planDocId)!
          const mirrored = statusEvents.filter((event) => event.type === "plan.updated").at(-1)!
          assert(mirrored, "Owned checkpoint must mirror the existing exact plan version")
          assert.equal(mirrored.data.plan_version, plan.version)
          assert.deepEqual(mirrored.data.steps, JSON.parse(plan.body).steps)
          assert.equal((yield* GoalTickCheckpointV2.read(db, row.permit_id))!.revision, checkpoint!.revision)
          assert.equal(requests.length, scenario === "manager-tests" ? 3 : 1)
        }
        return {
          statusEvents,
          checkpoint,
          inputs: yield* db.all("SELECT * FROM session_input"),
          units: yield* db.all("SELECT * FROM goal_child_unit"),
          active: Array.from(yield* (yield* SessionExecution.Service).active),
        }
      }
      if (
        scenario.startsWith("initialize") ||
        scenario === "program" ||
        scenario.startsWith("loop") ||
        scenario.startsWith("steer")
      ) {
        const docroot =
          scenario === "program" || scenario.startsWith("loop") || scenario.startsWith("steer")
            ? DeepAgentPlanStore.planStoreRoot(parent.id)
            : path.join(root, "owned-documents")
        const initialization = yield* GoalTickProjection.prepare(db, {
          directory: docroot,
          sessionID: parent.id,
          requestID: "initial-owned",
          plan: createPlanDoc(parent.id, "Verified initial plan", [
            { step_id: "one", title: scenario === "loop-capacity" ? "large".repeat(1000) : "Verify", status: "active" },
            ...(scenario.startsWith("loop-proposal-two")
              ? [{ step_id: "two", title: "Verify next", status: "pending" as const }]
              : []),
          ]),
          spec: {
            criteria:
              scenario === "loop-unverifiable"
                ? [{ kind: "plan_complete" }, { kind: "no_diagnostics" }]
                : scenario.startsWith("loop-proposal-diagnostics")
                  ? [{ kind: "plan_complete" }, { kind: "no_diagnostics" }]
                  : scenario === "loop-proposal-only" ||
                      scenario === "loop-proposal-two-uncovered" ||
                      scenario === "loop-capacity"
                    ? [{ kind: "plan_complete" }]
                    : scenario.startsWith("loop-proposal")
                      ? [{ kind: "plan_complete" }, { kind: "reviewer_clean", maxSeverity: "high" }]
                      : scenario.startsWith("loop")
                        ? [
                            {
                              kind: "tests_pass",
                              commands: [scenario === "loop-failed" ? "exit 1" : "printf verified"],
                            },
                            { kind: "reviewer_clean", maxSeverity: "high" },
                            { kind: "panel_approves" },
                          ]
                        : [{ kind: "tests_pass", commands: ["printf verified"] }],
            limits: { maxTicks: 3, maxTokens: 1000, maxWallclockMs: 60000 },
            stallThreshold: 3,
          },
          model: { providerID: "fixture", modelID: "test-model" },
          netTokenBudget: false,
          panel: {
            question: "Review",
            codeRefs: scenario.startsWith("loop-proposal-diagnostics") ? ["code.ts"] : [],
            lenses: ["correctness", "security", "architecture"],
            maxRounds: 2,
          },
        })
        const request = {
          sessionID: parent.id,
          requestID: "initial-owned",
          requestHash: GoalControl.fingerprint("initial-owned"),
          planDocId: initialization.spec.planDocId,
          initialization,
          driverMode: "event" as const,
        }
        const prepared = yield* GoalControl.reserveStart(db, request)
        const input = {
          row: prepared.row,
          requestID: request.requestID,
          requestHash: request.requestHash,
          directory: docroot,
        }
        if (scenario === "program" || scenario.startsWith("loop") || scenario.startsWith("steer")) {
          yield* GoalTickProjection.initialize(db, input)
          const tick = yield* GoalControl.beginTick(db, {
            sessionID: parent.id,
            goalId: prepared.row.goal_id,
            planDocId: request.planDocId,
            revision: 1,
            seq: 0,
            expectedPlanVersion: 1,
            mode: "event",
          })
          if (scenario === "loop-initial-mutated") {
            const stateID = `doc:run_context:${prepared.row.goal_id}`
            const documents = DocumentStore.openExact(
              docroot,
              prepared.row.initialization.ownedPreparation!.documents.map((item) => item.documentID),
            )
            const state = JSON.parse(documents.get(stateID)!.body)
            documents.update(
              stateID,
              JSON.stringify({ ...state, ledger: { ...state.ledger, startedAtMs: Date.now() + 60000 } }),
            )
            const refused = yield* GoalOwnedLoop.prepare({ permitID: tick.permit.permit_id, directory: docroot }).pipe(
              Effect.exit,
            )
            assert(Exit.isFailure(refused))
            assert(
              Cause.pretty(refused.cause).includes("Prior verified Goal projection changed"),
              Cause.pretty(refused.cause),
            )
            assert.equal(requests.length, 0)
            return {
              inputs: yield* db.all("SELECT * FROM session_input"),
              checkpoints: yield* db.all("SELECT permit_id FROM goal_tick_checkpoint"),
              units: yield* db.all("SELECT * FROM goal_child_unit"),
              active: Array.from(yield* (yield* SessionExecution.Service).active),
            }
          }
          if (scenario === "loop-capacity") {
            const refused = yield* GoalOwnedLoop.prepare({ permitID: tick.permit.permit_id, directory: docroot }).pipe(
              Effect.exit,
            )
            assert(Exit.isFailure(refused))
            assert(Cause.pretty(refused.cause).includes("cannot reserve"))
            assert.equal(requests.length, 0)
            return {
              inputs: yield* db.all("SELECT * FROM session_input"),
              checkpoints: yield* db.all("SELECT permit_id FROM goal_tick_checkpoint"),
              units: yield* db.all("SELECT * FROM goal_child_unit"),
              active: Array.from(yield* (yield* SessionExecution.Service).active),
            }
          }
          const unavailableValidation = Effect.gen(function* () {
            const exited = yield* GoalOwnedLoop.run({ permitID: tick.permit.permit_id, directory: docroot }).pipe(Effect.exit)
            assert(Exit.isFailure(exited))
            const failure = Cause.squash(exited.cause)
            assert(failure instanceof OwnedValidation.Error)
            assert.equal(failure.code, "PROFILE_UNAVAILABLE")
            const checkpoint = yield* GoalTickCheckpointV2.read(db, tick.permit.permit_id)
            assert(checkpoint)
            assert.equal(checkpoint.state, "recovery_required")
            assert.deepEqual(checkpoint.journal.localEffects, [])
            assert.equal(checkpoint.journal.nextState, null)
            const permit = yield* db.get<{ state: string }>(sql`SELECT state FROM goal_tick_permit WHERE permit_id=${tick.permit.permit_id}`)
            assert.equal(permit?.state, "unknown")
            const status = yield* (yield* GoalManager.Service).status(parent.id)
            assert(status?.recoveryRequired)
            assert.notEqual(status.phase, "done")
            assert.equal(requests.length, 1)
            const inputs = yield* db.all("SELECT * FROM session_input")
            const units = yield* db.all<{ state: string }>("SELECT * FROM goal_child_unit")
            assert.equal(inputs.length, 1)
            assert.equal(units.length, 1)
            assert.equal(units[0].state, "result_recorded")
            assert.deepEqual(OwnedValidation.inspectCustody(), {
              limit: OwnedValidation.VALIDATION_CUSTODY_LIMIT, live: 0, quarantine: 0,
            })
            stage("validation-refused", { code: failure.code, checkpoint: checkpoint.state, permit: permit.state,
              requests: requests.length, localEffects: checkpoint.journal.localEffects.length })
            return { refusal: failure.code, checkpoint, status, permit, inputs, units,
              validationCustody: OwnedValidation.inspectCustody(),
              active: Array.from(yield* (yield* SessionExecution.Service).active) }
          })
          if (scenario.startsWith("steer")) {
            const steer = yield* SessionSteer.Service
            const first = yield* steer.admit({
              sessionID: SessionID.make(parent.id),
              delivery: "goal_steer",
              correlationID: "first-steer",
              prompt: new Prompt({
                text: "FIRST_FROZEN_GUIDANCE",
                ...(scenario === "steer-unsupported" ? { agent: AgentV2.ID.make("reviewer") } : {}),
              }),
            })
            if (scenario === "steer-unsupported") {
              const rejected = yield* GoalOwnedLoop.prepare({
                permitID: tick.permit.permit_id,
                directory: docroot,
              }).pipe(Effect.exit)
              assert(Exit.isFailure(rejected))
              assert.equal((Cause.squash(rejected.cause) as { code: string }).code, "CHECKPOINT_INVALID")
              assert.equal((yield* db.all("SELECT permit_id FROM goal_tick_checkpoint")).length, 0)
            } else {
              const frozen = yield* GoalOwnedLoop.prepare({ permitID: tick.permit.permit_id, directory: docroot })
              yield* steer.admit({
                sessionID: SessionID.make(parent.id),
                delivery: "goal_steer",
                correlationID: "later-steer",
                prompt: new Prompt({ text: "LATER_GUIDANCE_NEXT_TICK" }),
              })
              if (scenario === "steer-aba") {
                yield* db.run(
                  sql`UPDATE session_steer SET prompt=${JSON.stringify({ text: "MUTATED_SAME_ID" })} WHERE id=${first.id}`,
                )
                assert(
                  Exit.isFailure(
                    yield* GoalOwnedLoop.run({ permitID: tick.permit.permit_id, directory: docroot }).pipe(Effect.exit),
                  ),
                )
              } else {
                if (process.platform !== "darwin" && scenario === "steer-valid") {
                  const result = yield* unavailableValidation
                  assert.equal(result.checkpoint.journal.parent.steering.rows[0].id,
                    frozen.checkpoint.journal.parent.steering.rows[0].id)
                  assert(JSON.stringify(requests).includes("FIRST_FROZEN_GUIDANCE"))
                  assert(!JSON.stringify(requests).includes("LATER_GUIDANCE_NEXT_TICK"))
                  return { ...result, steers: yield* db.all("SELECT id,prompt,consumed_seq FROM session_steer ORDER BY seq") }
                }
                const complete = yield* GoalOwnedLoop.run({ permitID: tick.permit.permit_id, directory: docroot })
                assert.equal(complete.state, "committed")
                assert.equal(
                  complete.journal.parent.steering.rows[0].id,
                  frozen.checkpoint.journal.parent.steering.rows[0].id,
                )
                assert(JSON.stringify(requests).includes("FIRST_FROZEN_GUIDANCE"))
                assert(!JSON.stringify(requests).includes("LATER_GUIDANCE_NEXT_TICK"))
              }
            }
            return {
              checkpoint: yield* GoalTickCheckpointV2.read(db, tick.permit.permit_id),
              steers: yield* db.all("SELECT id,prompt,consumed_seq FROM session_steer ORDER BY seq"),
              inputs: yield* db.all("SELECT * FROM session_input"),
              units: yield* db.all("SELECT * FROM goal_child_unit"),
              active: Array.from(yield* (yield* SessionExecution.Service).active),
            }
          }
          if (scenario.endsWith("-stop-boundary") || scenario.endsWith("-cancel-boundary")) {
            const exited = yield* GoalOwnedLoop.run({ permitID: tick.permit.permit_id, directory: docroot }).pipe(Effect.exit)
            assert(Exit.isFailure(exited))
            assert(rebaseControl)
            yield* Effect.promise(() => rebaseControl!)
            assert.equal(requests.length, 1)
            const goal = (yield* GoalControl.get(db, prepared.row.goal_id))!
            assert.equal(goal.requested_phase, scenario.endsWith("-cancel-boundary") ? "paused" : "stopped")
            assert.equal(goal.pending_rebase_id, null)
            const edit = (yield* GoalPlanRebase.read(db, rebaseBegin!.current.editID))!
            assert.equal(edit.state, "cancelled")
            if (scenario.endsWith("-stop-boundary")) assert.equal(edit.journal.controlInterruption?.reason, "control_stop")
            assert.deepEqual(edit.journal.commands[0].receipt, rebaseBegin!.originalReceipt)
            assert.equal((yield* GoalTickCheckpointV2.read(db, tick.permit.permit_id))!.state, "recovery_required")
            // The frame failure publishes its unknown obligation before waking control callers.
            assert.equal((yield* db.get<{ state: string }>(sql`SELECT state FROM goal_tick_permit WHERE permit_id=${tick.permit.permit_id}`))!.state, "unknown")
            assert(Exit.isFailure(yield* GoalTickCheckpoint.currentPermit(db, tick.permit.permit_id, tick.permit.token).pipe(Effect.exit)))
            const current = yield* Effect.promise(() => rebaseHTTP(`/${edit.edit_id}`, { sessionID: parent.id,
              goalID: goal.goal_id, requestID: "rebase-during-provider" }, "GET"))
            assert.equal(current.current.safeToResume, false)
            assert.equal(current.current.execution, "blocked")
            return { edit, control: goal, receipt: current, active: Array.from(yield* (yield* SessionExecution.Service).active) }
          }
          if (
            scenario === "loop-stop" ||
            scenario === "loop-missing-usage" ||
            scenario === "loop-proposal-mutated" ||
            scenario === "loop-proposal-two-broad" ||
            scenario === "loop-proposal-two-unknown"
          ) {
            const body = GoalOwnedLoop.run({ permitID: tick.permit.permit_id, directory: docroot })
            const exited = yield* (
              scenario === "loop-stop"
                ? Effect.gen(function* () {
                    const fiber = yield* body.pipe(Effect.forkChild)
                    stage("stop-waiting-for-provider")
                    yield* Effect.promise(() => firstProviderRequest.promise)
                    const admission = yield* db.all<{ unit_id: string; input_id: string }>(sql`
                      SELECT u.unit_id,i.id AS input_id FROM goal_child_unit u
                      JOIN session_input i ON i.session_id=u.child_session_id
                      WHERE u.permit_id=${tick.permit.permit_id}`)
                    assert.equal(requests.length, 1)
                    assert.equal(admission.length, 1)
                    stage("stop-admission-observed", { requests: requests.length, admissions: admission.length })
                    yield* (yield* GoalManager.Service).stop({
                      sessionID: parent.id,
                      goalId: prepared.row.goal_id,
                      requestID: "actual-manager-stop",
                      expectedRevision: 1,
                    })
                    return yield* Fiber.join(fiber)
                  })
                : body
            ).pipe(Effect.exit)
            assert(Exit.isFailure(exited))
            assert.equal(
              requests.length,
              scenario === "loop-proposal-mutated" ||
                scenario === "loop-proposal-two-broad" ||
                scenario === "loop-proposal-two-unknown"
                ? 2
                : 1,
            )
            assert(
              Exit.isFailure(
                yield* GoalOwnedLoop.run({ permitID: tick.permit.permit_id, directory: docroot }).pipe(Effect.exit),
              ),
            )
            assert.equal(
              requests.length,
              scenario === "loop-proposal-mutated" ||
                scenario === "loop-proposal-two-broad" ||
                scenario === "loop-proposal-two-unknown"
                ? 2
                : 1,
            )
            return {
              checkpoint: yield* GoalTickCheckpointV2.read(db, tick.permit.permit_id),
              inputs: yield* db.all("SELECT * FROM session_input"),
              units: yield* db.all("SELECT * FROM goal_child_unit"),
              active: Array.from(yield* (yield* SessionExecution.Service).active),
              control: yield* GoalControl.get(db, prepared.row.goal_id),
            }
          }
          if (scenario.startsWith("loop")) {
            if (process.platform !== "darwin" && (scenario === "loop" || scenario === "loop-failed"))
              return yield* unavailableValidation
            if (scenario === "loop-cold") {
              const original = DocumentStore.prototype.projectExact
              DocumentStore.prototype.projectExact = function (payload, expected) {
                const doc = original.call(this, payload, expected)
                if (doc.type === "worklog" && doc.version === 2) {
                  writeFileSync(
                    path.join(root, "cold-window.json"),
                    JSON.stringify({ pid: process.pid, docID: doc.id, version: doc.version, hash: doc.hash }),
                  )
                  stage("cold-window-published")
                  process.kill(process.pid, "SIGSTOP")
                }
                return doc
              }
            }
            stage("loop-run-started")
            const complete = yield* GoalOwnedLoop.run({ permitID: tick.permit.permit_id, directory: docroot })
            stage("loop-run-completed", { checkpoint: complete.state, requests: requests.length })
            const beforeRetry = requests.length
            const retried = yield* GoalOwnedLoop.run({ permitID: tick.permit.permit_id, directory: docroot })
            assert.equal(retried.revision, complete.revision)
            assert.equal(requests.length, beforeRetry)
            if (scenario.startsWith("loop-proposal-two")) {
              const firstPlan = DocumentStore.openExact(docroot, [request.planDocId]).get(request.planDocId)!
              const firstState = JSON.parse(complete.journal.nextState!)
              const firstBody = DeepAgentPlanStore.decodePlanDoc(firstPlan.body)!
              if (scenario === "loop-proposal-two-uncovered") {
                assert.deepEqual(
                  firstBody.steps.map((step) => step.status),
                  ["active", "pending"],
                )
                assert.equal(firstState.phase, "needs_human")
                assert.equal(requests.length, 2)
                return {
                  checkpoint: complete,
                  inputs: yield* db.all("SELECT * FROM session_input"),
                  units: yield* db.all("SELECT * FROM goal_child_unit"),
                  active: Array.from(yield* (yield* SessionExecution.Service).active),
                }
              }
              assert.deepEqual(
                firstBody.steps.map((step) => step.status),
                ["done", "active"],
              )
              assert.equal(firstState.phase, "running")
              assert.equal(requests.length, 4)
              if (scenario === "loop-proposal-two-cold") {
                writeFileSync(
                  path.join(root, "cold-window.json"),
                  JSON.stringify({ pid: process.pid, permitID: tick.permit.permit_id }),
                )
                process.kill(process.pid, "SIGSTOP")
                throw new Error("Cold fixture must be killed")
              }
              if (scenario.startsWith("loop-proposal-two-rebase")) {
                assert(rebaseBegin)
                if (scenario.includes("-ask-")) {
                  const ready = yield* Effect.promise(() => rebaseHTTP(`/${rebaseBegin!.current.editID}`, {
                    sessionID: parent.id, goalID: prepared.row.goal_id, requestID: "rebase-during-provider" }, "GET"))
                  const cancelled = yield* Effect.promise(() => rebaseHTTP("/cancel", { sessionID: parent.id,
                    goalID: prepared.row.goal_id, editID: ready.current.editID, requestID: "cancel-before-ask-scope",
                    expectedEditRevision: ready.current.revision, expectedControlRevision: ready.current.controlRevision }))
                  yield* db.run(sql`UPDATE session SET permission=${JSON.stringify([{ action: "*", resource: "*", effect: "allow" }, { action: "plan", resource: "*", effect: "ask" }])} WHERE id=${parent.id}`)
                  rebaseBegin = yield* Effect.promise(() => rebaseHTTP("/begin", { sessionID: parent.id, goalID: prepared.row.goal_id,
                    requestID: "rebase-after-ask-scope", expectedControlRevision: cancelled.current.controlRevision }))
                }
                const goal = (yield* GoalControl.get(db, prepared.row.goal_id))!
                assert.equal(goal.requested_phase, "paused")
                assert(goal.pending_rebase_id)
                const refused = yield* GoalControl.beginTick(db, { sessionID: parent.id, goalId: goal.goal_id,
                  planDocId: goal.plan_doc_id, revision: goal.revision, seq: 1, expectedPlanVersion: goal.plan_version, mode: "event" }).pipe(Effect.exit)
                assert(Exit.isFailure(refused))
                assert.equal(requests.length, 4)
                const before = yield* db.all("SELECT * FROM goal_tick_checkpoint")
                const current = yield* Effect.promise(() => rebaseHTTP(`/${rebaseBegin!.current.editID}`, {
                  sessionID: parent.id, goalID: goal.goal_id, requestID: rebaseBegin!.originalReceipt!.requestID }, "GET"))
                assert.equal(current.current.state, "ready")
                assert.equal(current.current.editSource?.planDocHash, firstPlan.hash.slice(7))
                assert.equal(current.current.editSource?.planDocument.body, firstPlan.body)
                assert.equal(current.originalReceipt?.state, scenario.includes("-ask-") ? "ready" : "waiting_boundary")
                assert.deepEqual(yield* db.all("SELECT * FROM goal_tick_checkpoint"), before)
                const apply = { sessionID: parent.id, goalID: goal.goal_id, editID: current.current.editID,
                  requestID: "rebase-actual-apply", expectedEditRevision: current.current.revision,
                  expectedControlRevision: goal.revision, expectedPlanRevision: 0, expectedDocVersion: firstPlan.version,
                  expectedDocHash: firstPlan.hash.slice(7), reason: "Refine remaining step after the settled first proof",
                  candidate: { steps: firstBody.steps.map((step) => step.step_id === "two" ? { ...step, title: "Revised second step", note: "Operator clarified acceptance" } : step),
                    activeStepID: firstBody.active_step_id, dispositions: [{ stepID: "two", reason: "Retain unsettled next step identity and evidence" }] } }
                yield* Effect.promise(() => Bun.write(path.join(root, "rebase-request.json"), JSON.stringify(apply)))
                if (scenario.endsWith("-clients")) {
                  const outcomes = yield* Effect.promise(() => Promise.all(["a", "b"].map((client) =>
                    rebaseHTTP("/apply", { ...apply, requestID: `competing-${client}`, reason: `Exact client ${client}` }).then(
                      (receipt) => ({ accepted: true, receipt }), (error: unknown) => ({ accepted: false, error: String(error) })))))
                  assert.equal(outcomes.filter((item) => item.accepted).length, 1)
                  assert.equal(outcomes.filter((item) => !item.accepted).length, 1)
                  const edit = (yield* GoalPlanRebase.read(db, apply.editID))!
                  assert.equal(edit.state, "committed")
                  assert.equal(edit.journal.commands.length, 2)
                  assert.equal((yield* GoalControl.get(db, goal.goal_id))!.plan_revision, 1)
                  assert.equal(DocumentStore.openExact(docroot, [firstPlan.id]).get(firstPlan.id)!.version, firstPlan.version + 1)
                  assert.equal(requests.length, 4)
                  assert.deepEqual(yield* db.all("SELECT * FROM goal_tick_checkpoint"), before)
                  return { checkpoint: complete, edit, inputs: yield* db.all("SELECT * FROM session_input"), active: Array.from(yield* (yield* SessionExecution.Service).active) }
                }
                if (scenario.includes("-ask-")) {
                  const locations = yield* LocationServiceMap
                  const documents = initialization.ownedPreparation!.documents.map((item) => item.documentID)
                  const beforeFiles = documents.map((id) => DocumentStore.openExact(docroot, [id]).get(id)!.hash)
                  const fiber = yield* Effect.tryPromise({ try: () => rebaseHTTP("/apply", apply), catch: (error) => error }).pipe(Effect.exit, Effect.forkChild)
                  for (let n = 0; n < 500; n++) {
                    const pending = yield* PermissionV2.Service.use((permissions) => permissions.forSession(parent.id)).pipe(Effect.provide(locations.get(parent.location)))
                    if (pending.length) break
                    if (n === 499) throw new Error("Actual Goal edit permission request did not arrive")
                    yield* Effect.sleep("5 millis")
                  }
                  if (scenario.endsWith("-parent")) {
                    yield* sessions.switchAgent({ sessionID: parent.id, agent: "plan" })
                    yield* sessions.switchAgent({ sessionID: parent.id, agent: parent.agent ?? "auto" })
                  }
                  if (scenario.endsWith("-roster")) yield* AgentV2.Service.use((agents) => agents.update((editor) => editor.update(AgentV2.defaultID, () => {}))).pipe(Effect.provide(locations.get(parent.location)))
                  if (scenario.endsWith("-doc")) DocumentStore.openExact(docroot, [firstPlan.id]).update(firstPlan.id, firstPlan.body + " ")
                  yield* PermissionV2.Service.use((permissions) => Effect.gen(function* () {
                    const pending = yield* permissions.forSession(parent.id)
                    assert.equal(pending.length, 1)
                    yield* permissions.reply({ requestID: pending[0]!.id, reply: scenario.endsWith("-reject") ? "reject" : "once" })
                  })).pipe(Effect.provide(locations.get(parent.location)))
                  const rejected = yield* Fiber.join(fiber)
                  assert(Exit.isFailure(rejected))
                  if (scenario.endsWith("-reject")) assert(String(Cause.squash(rejected.cause)).includes("APPROVAL_REJECTED"))
                  const edit = (yield* GoalPlanRebase.read(db, apply.editID))!
                  assert.equal(edit.state, "ready")
                  assert.equal(edit.journal.fileStarted, false)
                  assert.equal(edit.journal.commands.length, 1)
                  if (!scenario.endsWith("-doc")) assert.deepEqual(documents.map((id) => DocumentStore.openExact(docroot, [id]).get(id)!.hash), beforeFiles)
                  assert.equal(requests.length, 4)
                  return { checkpoint: complete, edit, inputs: yield* db.all("SELECT * FROM session_input"), active: Array.from(yield* (yield* SessionExecution.Service).active) }
                }
                if (scenario.includes("-cold-")) {
                  const authorize: GoalPlanRebase.Authority = (reader, sessionID, goalID) => GoalControl.requireTarget(reader, goalID, sessionID).pipe(
                    Effect.asVoid, Effect.mapError(() => new GoalPlanRebaseSchema.Error({ code: "AUTH_CHANGED", message: "Native target changed" })))
                  const stop = (window: string) => {
                    writeFileSync(path.join(root, "cold-window.json"), JSON.stringify({ pid: process.pid, window, editID: apply.editID }))
                    process.kill(process.pid, "SIGSTOP")
                    throw new Error("Cold fixture must be killed")
                  }
                  const candidate = yield* GoalPlanRebase.prepare(db, apply, docroot, authorize)
                  if (scenario.endsWith("-prepare")) stop("prepare")
                  const original = DocumentStore.prototype.projectExact
                  const counter = { value: 0 }
                  DocumentStore.prototype.projectExact = function (payload, expected) {
                    const doc = original.call(this, payload, expected)
                    counter.value++
                    if (scenario.endsWith(`-file${counter.value}`)) stop(`file${counter.value}`)
                    return doc
                  }
                  for (const document of candidate.row.journal.documents)
                    yield* GoalPlanRebase.project(db, apply.editID, document.documentID, docroot, authorize)
                  yield* GoalPlanRebase.settle(db, apply.editID, docroot, authorize)
                  stop("commit")
                }
                const committed = scenario.endsWith("-cli") ? yield* Effect.promise(async () => {
                  const filename = path.join(root, "rebase request $file.json")
                  await Bun.write(filename, JSON.stringify(apply))
                  assert(listener)
                  const cli = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../../src/index.ts"), "goal", "plan-rebase", "apply", filename,
                    "--attach", listener.url.toString(), "--password", "goal-rebase-fixture", "--format", "json"], {
                    cwd: directory, env: process.env, stdout: "pipe", stderr: "pipe" })
                  const output = Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text()])
                  const status = await cli.exited
                  const logs = await output
                  await Bun.write(path.join(root, "cli-output.json"), JSON.stringify({ status, logs }))
                  assert.equal(status, 0, logs.join("\n"))
                  return Schema.decodeUnknownSync(Schema.fromJsonString(GoalPlanRebaseSchema.Response))(logs[0])
                }) : yield* Effect.promise(() => rebaseHTTP("/apply", apply))
                assert.equal(committed.current.state, "committed")
                assert.equal(committed.current.safeToResume, true)
                assert.equal(requests.length, 4)
                const retried = yield* Effect.promise(() => rebaseHTTP("/apply", apply))
                assert.deepEqual(retried.originalReceipt, committed.originalReceipt)
                assert.deepEqual(yield* db.all("SELECT * FROM goal_tick_checkpoint"), before)
                const edited = (yield* GoalControl.get(db, goal.goal_id))!
                assert.equal(edited.plan_revision, 1)
                assert.equal(edited.requested_phase, "paused")
                yield* GoalControl.control(db, { sessionID: parent.id, goalId: goal.goal_id,
                  expectedRevision: edited.revision, requestID: "explicit-resume-rebased", action: "resume" })
              }
              const second = yield* GoalControl.beginTick(db, {
                sessionID: parent.id,
                goalId: prepared.row.goal_id,
                planDocId: request.planDocId,
                revision: (yield* GoalControl.get(db, prepared.row.goal_id))!.revision,
                seq: 1,
                expectedPlanVersion: scenario.startsWith("loop-proposal-two-rebase") ? (yield* GoalControl.get(db, prepared.row.goal_id))!.plan_version : firstPlan.version,
                mode: "event",
              })
              if (scenario === "loop-proposal-two-mutated") {
                DocumentStore.openExact(docroot, [request.planDocId]).update(request.planDocId, firstPlan.body + " ")
                const refused = yield* GoalOwnedLoop.run({
                  permitID: second.permit.permit_id,
                  directory: docroot,
                }).pipe(Effect.exit)
                assert(Exit.isFailure(refused))
                assert(Cause.pretty(refused.cause).includes("Prior verified Goal projection changed"))
                assert.equal(requests.length, 4)
                assert.equal((yield* db.all("SELECT id FROM session_input")).length, 3)
                return {
                  checkpoint: complete,
                  inputs: yield* db.all("SELECT * FROM session_input"),
                  units: yield* db.all("SELECT * FROM goal_child_unit"),
                  active: Array.from(yield* (yield* SessionExecution.Service).active),
                }
              }
              const done = yield* GoalOwnedLoop.run({ permitID: second.permit.permit_id, directory: docroot })
              assert.equal(JSON.parse(done.journal.nextState!).phase, "done")
              assert.equal(requests.length, 8)
              const finalBody = DeepAgentPlanStore.decodePlanDoc(
                DocumentStore.openExact(docroot, [request.planDocId]).get(request.planDocId)!.body,
              )!
              assert.deepEqual(finalBody.steps[0], firstBody.steps[0])
              if (scenario.startsWith("loop-proposal-two-rebase")) {
                assert.equal(finalBody.steps[1].title, "Revised second step")
                assert.equal(done.journal.program.version, 3)
                assert.equal(done.journal.program.version === 3 && done.journal.program.planLineage.planRevision, 1)
              }
              const again = yield* GoalOwnedLoop.run({ permitID: tick.permit.permit_id, directory: docroot })
              assert.equal(again.revision, complete.revision)
              assert.equal(requests.length, 8)
              return {
                checkpoint: done,
                first: complete,
                inputs: yield* db.all("SELECT * FROM session_input"),
                units: yield* db.all("SELECT * FROM goal_child_unit"),
                active: Array.from(yield* (yield* SessionExecution.Service).active),
              }
            }
            return {
              checkpoint: complete,
              inputs: yield* db.all("SELECT * FROM session_input"),
              units: yield* db.all("SELECT * FROM goal_child_unit"),
              active: Array.from(yield* (yield* SessionExecution.Service).active),
            }
          }
          const accepted = yield* GoalOwnedLoop.prepare({ permitID: tick.permit.permit_id, directory: docroot })
          assert(accepted.checkpoint.journal.program.roles[0].scratch)
          const frames = yield* GoalTickExecution.Service
          const result = yield* frames.withFrame(tick.permit, (frame) =>
            GoalOwnedTurn.run({
              permitID: tick.permit.permit_id,
              frame,
              role: 0,
              text: accepted.workerRecipe,
            }),
          )
          assert.equal(result.result.outcome, "valid")
          const units = yield* db.all<{ inputs: string; child_session_id: string }>("SELECT * FROM goal_child_unit")
          const unit = yield* GoalChild.read(
            db,
            `goalchild_${GoalControl.fingerprint([tick.permit.permit_id, "worker.0"])}`,
          )
          assert(unit?.inputs[0].scratch)
          const scratch = accepted.checkpoint.journal.program.roles[0].scratch!
          const actual = DocumentStore.openExact(DeepAgentPlanStore.planStoreRoot(units[0].child_session_id), [
            scratch.documentID,
          ]).get(scratch.documentID)
          assert.equal(actual?.version, 1)
          return {
            checkpoint: yield* GoalTickCheckpointV2.read(db, tick.permit.permit_id),
            inputs: yield* db.all("SELECT * FROM session_input"),
            units,
            active: Array.from(yield* (yield* SessionExecution.Service).active),
          }
        }
        yield* db.run(
          sql`CREATE TRIGGER c2_init_failure BEFORE UPDATE ON goal_control WHEN NEW.preparation='ready' BEGIN SELECT RAISE(ABORT,'fixture init rollback'); END`,
        )
        const failed = yield* GoalTickProjection.initialize(db, input).pipe(Effect.exit)
        assert(Exit.isFailure(failed))
        assert.equal((yield* GoalControl.get(db, prepared.row.goal_id))!.preparation, "preparing")
        const exact = DocumentStore.openExact(
          docroot,
          initialization.ownedPreparation!.documents.map((item) => item.documentID),
        )
        assert.equal(initialization.ownedPreparation!.documents.filter((item) => exact.get(item.documentID)).length, 5)
        const before = initialization.ownedPreparation!.documents.map((item) => exact.get(item.documentID)!.hash)
        yield* db.run(sql`DROP TRIGGER c2_init_failure`)
        if (scenario === "initialize-conflict") {
          exact.update(request.planDocId, "external writer different bytes")
          assert(Exit.isFailure(yield* GoalTickProjection.initialize(db, input).pipe(Effect.exit)))
          assert.equal((yield* GoalControl.get(db, prepared.row.goal_id))!.preparation, "preparing")
        } else {
          const receipt = yield* GoalTickProjection.initialize(db, input)
          assert.equal(receipt.revision, 1)
          const after = DocumentStore.openExact(
            docroot,
            initialization.ownedPreparation!.documents.map((item) => item.documentID),
          )
          assert.deepEqual(
            initialization.ownedPreparation!.documents.map((item) => after.get(item.documentID)!.hash),
            before,
          )
        }
        return {
          initialization: yield* GoalControl.get(db, prepared.row.goal_id),
          inputs: yield* db.all("SELECT * FROM session_input"),
          units: yield* db.all("SELECT * FROM goal_child_unit"),
          active: Array.from(yield* (yield* SessionExecution.Service).active),
        }
      }
      const documents = new DocumentStore(path.join(root, "documents"))
      const plan = documents.create({
        type: "plan",
        scope: `run:${parent.id}`,
        body: "original plan",
        description: "C2 source",
        provenance: { source: "runner", run_ref: parent.id },
      })
      const start = {
        sessionID: parent.id,
        requestID: "c2-start",
        requestHash: GoalControl.fingerprint(parent.id),
        planDocId: plan.id,
        initialization: {
          ...GoalControlFixture.initialization,
          spec: {
            ...GoalControlFixture.initialization.spec,
            planDocId: plan.id,
            ...(scenario.startsWith("validation")
              ? {
                  criteria: [
                    {
                      kind: "tests_pass" as const,
                      commands: [
                        scenario === "validation-admin-deny"
                          ? "printf forbidden > denied-marker; git push origin"
                          : scenario === "validation-external-deny"
                            ? `printf forbidden > denied-marker; cat ${path.join(root, "outside")}`
                            : scenario === "validation-deny" || scenario.startsWith("validation-ask-")
                              ? "printf forbidden > denied-marker"
                              : scenario !== "validation"
                                ? "while :; do :; done"
                                : "printf validated",
                      ],
                    },
                  ],
                }
              : {}),
          },
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
      const mode = scenario === "structured" ? ("structured" as const) : ("plain" as const)
      const schema = Schema.Struct({ ok: Schema.Boolean })
      const program: GoalTickProgram.Program = {
        version: 2,
        contract: "owned-goal-v2",
        roles: [
          {
            key: "worker.0",
            agent: "goal-worker",
            kind: "worker",
            ordinal: 0,
            criterion: null,
            round: null,
            lens: null,
            mode,
            policyHash: GoalChildPolicy.roleHash(pair.parent, pair.child)!,
            recipe: {
              id: "goal-worker-v2",
              hash: GoalTickProgram.hash("actual fixture recipe"),
              schemaHash: GoalControl.fingerprint(
                mode === "structured" ? Schema.toJsonSchemaDocument(schema) : { type: "string" },
              ),
              dependencies: [],
            },
          },
        ],
        documents: [],
        localEffectSlots: scenario.startsWith("validation") ? 1 : 0,
        nextStateBytes: 0,
      }
      yield* GoalTickCheckpointV2.begin(db, {
        permitID: tick.permit.permit_id,
        permitToken: tick.permit.token,
        program,
      })
      const frames = yield* GoalTickExecution.Service
      if (scenario.startsWith("validation")) {
        if (scenario === "validation-admin-deny")
          yield* Policy.Service.use((policy) =>
            policy.load([
              new Policy.Info({ action: ServerCapabilities.Actions.gitPush, resource: "*", effect: "deny" }),
            ]),
          ).pipe(Effect.provide(locations.get(parent.location)))
        const task = frames.withFrame(tick.permit, (frame) =>
          GoalOwnedTurn.validate({
            permitID: tick.permit.permit_id,
            frame,
            ordinal: 0,
            timeoutMs: scenario === "validation-cancel" ? 50 : 10000,
          }),
        )
        const completed = yield* (
          process.platform === "darwin" && (scenario === "validation-control" || scenario.startsWith("validation-ask-"))
            ? Effect.gen(function* () {
                const fiber = yield* task.pipe(Effect.forkChild)
                for (let n = 0; n < 500; n++) {
                  const row = yield* GoalTickCheckpointV2.read(db, tick.permit.permit_id)
                  if (scenario.startsWith("validation-ask-")) {
                    const pending = yield* PermissionV2.Service.use((permissions) =>
                      permissions.forSession(parent.id),
                    ).pipe(Effect.provide(locations.get(parent.location)))
                    if (pending.length) break
                  } else if (row?.journal.localEffects[0]?.state === "dispatched") break
                  if (n === 499) throw new Error("Validation dispatch did not arrive")
                  yield* Effect.sleep("5 millis")
                }
                if (scenario.startsWith("validation-ask-") && scenario !== "validation-ask-stop") {
                  if (scenario === "validation-ask-agent") {
                    const sessions = yield* SessionV2.Service
                    const refused = yield* sessions.switchAgent({ sessionID: parent.id, agent: "plan" }).pipe(Effect.exit)
                    assert(Exit.isFailure(refused))
                    const error = Exit.isFailure(refused) ? Cause.squash(refused.cause) : undefined
                    assert(error && typeof error === "object" && "code" in error && error.code === "GOAL_MODE_CHANGE_BUSY")
                    // Admission prevents a public mode change during a Goal. The real historical
                    // event projector still has to reject a parent ABA, as in the Core oracle.
                    const events = yield* EventV2Bridge.Service
                    const timestamp = yield* DateTime.now
                    const original = yield* GoalControl.session(db, parent.id)
                    yield* events.publish(SessionEvent.AgentSwitched, {
                      sessionID: parent.id,
                      agent: AgentV2.ID.make("plan"),
                      timestamp,
                      messageID: SessionMessage.ID.create(),
                    })
                    yield* events.publish(SessionEvent.Updated, {
                      sessionID: parent.id,
                      info: parent,
                      slug: original.slug,
                      version: original.version,
                    })
                    assert.equal(
                      GoalControl.fingerprint(GoalTickCheckpoint.authority(yield* GoalControl.session(db, parent.id))),
                      (yield* GoalTickCheckpointV2.read(db, tick.permit.permit_id))!.journal.parent.authorityHash,
                    )
                  }
                  if (scenario === "validation-ask-roster")
                    yield* AgentV2.Service.use((agents) =>
                      agents.update((editor) => editor.update(AgentV2.defaultID, () => {})),
                    ).pipe(Effect.provide(locations.get(parent.location)))
                  if (scenario === "validation-ask-cwd")
                    yield* Effect.promise(async () => {
                      await fs.rename(directory, `${directory}-previous`)
                      await fs.mkdir(directory)
                    })
                  yield* PermissionV2.Service.use((permissions) =>
                    Effect.gen(function* () {
                      const pending = yield* permissions.forSession(parent.id)
                      assert.equal(pending.length, 1)
                      yield* permissions.reply({ requestID: pending[0]!.id, reply: "once" })
                    }),
                  ).pipe(Effect.provide(locations.get(parent.location)))
                  return yield* Fiber.join(fiber)
                }
                const control = yield* GoalControl.control(db, {
                  sessionID: parent.id,
                  goalId: goal.row.goal_id,
                  expectedRevision: 1,
                  requestID: "control-stop",
                  action: "stop",
                })
                yield* frames.control(goal.row.goal_id, control.revision)
                return yield* Fiber.join(fiber)
              })
            : task
        ).pipe(Effect.exit)
        if (process.platform !== "darwin") {
          assert(Exit.isFailure(completed))
          const failure = Cause.squash(completed.cause)
          assert(failure instanceof OwnedValidation.Error)
          assert.equal(failure.code, "PROFILE_UNAVAILABLE")
          const checkpoint = yield* GoalTickCheckpointV2.read(db, tick.permit.permit_id)
          assert(checkpoint)
          assert.equal(checkpoint.state, "recovery_required")
          assert.deepEqual(checkpoint.journal.localEffects, [])
          assert(!(yield* Effect.promise(() => Bun.file(path.join(directory, "denied-marker")).exists())))
          assert.deepEqual(OwnedValidation.inspectCustody(), {
            limit: OwnedValidation.VALIDATION_CUSTODY_LIMIT, live: 0, quarantine: 0,
          })
          return {
            refusal: failure.code, checkpoint,
            inputs: yield* db.all("SELECT * FROM session_input"),
            units: yield* db.all("SELECT * FROM goal_child_unit"),
            active: Array.from(yield* (yield* SessionExecution.Service).active),
            validationCustody: OwnedValidation.inspectCustody(),
          }
        }
        if (scenario === "validation") {
          assert(Exit.isSuccess(completed), Exit.isFailure(completed) ? Cause.pretty(completed.cause) : "")
          assert(completed.value.pass)
        } else assert(Exit.isFailure(completed))
        if (
          ["validation-deny", "validation-admin-deny", "validation-external-deny"].includes(scenario) ||
          scenario.startsWith("validation-ask-")
        )
          assert(!(yield* Effect.promise(() => Bun.file(path.join(directory, "denied-marker")).exists())))
      } else {
        const output = yield* frames.withFrame(tick.permit, (frame) =>
          GoalOwnedTurn.run({
            permitID: tick.permit.permit_id,
            frame,
            role: 0,
            text:
              scenario === "plan"
                ? "Create your scratch plan using the plan tool, then return a short result."
                : "Return a short deterministic result. Do not call tools.",
            ...(mode === "structured" ? { resultSchema: schema } : {}),
          }),
        )
        assert.equal(output.result.outcome, "valid")
        if (scenario === "plan") {
          // Historical Goal proofs used these exact sixteen public fields. The
          // new private native-read envelope must not enter persisted Goal hashes.
          const admissions = yield* db.all(sql`SELECT a.* FROM session_v2_tool_effect_admission a
            JOIN session_v2_provider_turn_receipt r ON r.receipt_id=a.receipt_id
            WHERE r.activity_id=${output.result.activityID} ORDER BY a.admission_id`)
          const effects = yield* db.all(sql`SELECT e.effect_id,e.session_id,e.provider_attempt_id,e.receipt_id,e.tool_call_id,e.tool_name,e.effect_kind,e.state,e.outcome_hash,e.error_code,e.grant_receipt_id,e.grant_owner_id,e.grant_state,e.grant_version,e.owner_token,e.time_created FROM session_v2_tool_effect e
            JOIN session_v2_provider_turn_receipt r ON r.receipt_id=e.receipt_id
            WHERE r.activity_id=${output.result.activityID} ORDER BY e.effect_id`)
          assert(effects.length > 0, "actual Plan tool must settle before compatibility is checked")
          assert.equal(output.result.tools.hash, GoalControl.fingerprint({ admissions, effects,
            ...(output.proposal ? { proposal: output.proposal.receipt } : {}) }))
          const proof = yield* GoalChildResult.inspect(db, output.result.unitID, output.result.stage)
          assert.deepEqual((yield* GoalChildResult.recheck(db, proof)).result, output.result)
        }
      }
      const units = yield* db.all("SELECT * FROM goal_child_unit")
      return {
        checkpoint: yield* GoalTickCheckpointV2.read(db, tick.permit.permit_id),
        inputs: yield* db.all("SELECT * FROM session_input"),
        units,
        active: Array.from(yield* (yield* SessionExecution.Service).active),
      }
    }).pipe(Effect.provide(SessionSteer.layer), Effect.scoped, Effect.tapCause((cause) => Effect.sync(() =>
      stage("runtime-failed", { errors: Cause.prettyErrors(cause).slice(0, 2).map((error) => {
        const codes = {
          PROFILE_UNAVAILABLE: "profile_unavailable",
          LOCAL_OPERATOR_UNAVAILABLE: "native_operator_unavailable",
          WORK_BINDING_CONFLICT: "work_binding_conflict",
          EVENT_CONSUMPTION_UNAVAILABLE: "event_consumption_unavailable",
          SQLITE_BUSY: "sqlite_busy", SQLITE_LOCKED: "sqlite_locked", SQLITE_CANTOPEN: "sqlite_unavailable",
          SQLITE_READONLY: "sqlite_readonly", SQLITE_IOERR: "sqlite_io", SQLITE_CORRUPT: "sqlite_corrupt",
          SQLITE_NOTADB: "sqlite_not_database", ENOENT: "filesystem_missing", EACCES: "filesystem_denied",
          EPERM: "filesystem_denied", ERR_ASSERTION: "assertion_failed",
        } as const
        const rawCode: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value
        const code = typeof rawCode === "string" && Object.hasOwn(codes, rawCode) ? rawCode as keyof typeof codes : undefined
        const tag: unknown = Object.getOwnPropertyDescriptor(error, "_tag")?.value
        const name: unknown = Object.getOwnPropertyDescriptor(error, "name")?.value
        return {
          name: name === "AssertionError" ? "AssertionError" : error instanceof TypeError ? "TypeError"
            : error instanceof RangeError ? "RangeError" : error instanceof SyntaxError ? "SyntaxError" : "Error",
          tag: tag === "OwnedValidationError" ? "OwnedValidationError" : tag === "WorkAuthorityError" ? "WorkAuthorityError"
            : tag === "LocalOperatorError" ? "LocalOperatorError" : tag === "GoalChild.Error" ? "GoalChild.Error"
            : tag === "DatabaseBootstrapError" ? "DatabaseBootstrapError" : "UnclassifiedError",
          code: code ?? "UNCLASSIFIED",
          reason: code ? codes[code] : "unclassified_error",
        }
      }) })))),
  )
  await Bun.write(path.join(root, "result.json"), JSON.stringify({ requests: requests.length, result }))
} finally {
  await listener?.stop()
  await new Promise<void>((resolve, reject) => provider.close((error) => (error ? reject(error) : resolve())))
}
process.exit(0)
