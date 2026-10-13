// Real Root / PermissionV2 / SessionExecutionLocal / canonical runner; only the loopback
// provider is controlled. Persisted source setup calls the real admission/activity authority.
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createServer, type ServerResponse } from "node:http"
import { sql } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { DeepAgentActivityAuthority } from "@deepagent-code/core/deepagent/activity-authority"
import { SessionContext } from "@deepagent-code/core/context-federation/session-context"
import { EventV2 } from "@deepagent-code/core/event"
import { Location } from "@deepagent-code/core/location"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { PermissionSaved } from "@deepagent-code/core/permission/saved"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionInput } from "@deepagent-code/core/session/input"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionRunnerCanonical } from "@deepagent-code/core/session/runner/canonical-turn"
import { Hash } from "@deepagent-code/core/util/hash"
import { AppRuntime } from "@/effect/app-runtime"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Server } from "@/server/server"

const root = process.argv[2]!
const directory = path.join(root, "project")
const cases: Record<string, string> = {}
const providerRequests: unknown[] = []
const responses: ServerResponse[] = []
const provider = createServer(async (request, response) => {
  assert.equal(request.url, "/v1/chat/completions")
  const parts: Buffer[] = []
  for await (const part of request) parts.push(Buffer.from(part))
  providerRequests.push(JSON.parse(Buffer.concat(parts).toString()))
  responses.push(response)
  await Bun.write(path.join(root, "provider.json"), JSON.stringify(providerRequests, null, 2))
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
    permission: { "*": "deny" },
    provider: {
      fixture: {
        name: "Private no-progress oracle",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        options: { apiKey: "private-fixture", baseURL: `http://127.0.0.1:${address.port}/v1` },
        models: {
          "test-model": {
            name: "Fixture",
            tool_call: true,
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
          },
        },
      },
    },
  }),
)
const rg = Bun.which(process.platform === "win32" ? "rg.exe" : "rg")
assert(rg)
const bin = path.join(root, "home/.deepagent/code/cache/bin")
await fs.mkdir(bin, { recursive: true })
await fs.copyFile(rg, path.join(bin, path.basename(rg)))

await AppRuntime.runPromise(Database.Service)
const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
assert.equal(Database.path(), path.join(root, "authority.sqlite"))
async function request(route: string, method = "GET", body?: unknown) {
  const response = await fetch(new URL(route, listener.url), {
    method,
    headers: {
      authorization: `Basic ${btoa("operator:test-secret")}`,
      "x-deepagent-code-directory": directory,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  })
  const text = await response.text()
  const value: unknown =
    text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text || undefined
  if (response.status >= 400) console.log("HTTP_REFUSAL", route, response.status, value)
  return { status: response.status, body: value }
}
async function waitFor(name: string, predicate: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`Timed out: ${name}`)
}
async function createChallenge(name: string) {
  const session = await request("/api/session", "POST", {
    agent: "auto",
    model: { providerID: "fixture", id: "test-model" },
  })
  assert.equal(session.status, 200, JSON.stringify(session.body))
  const sessionID = SessionSchema.ID.make((session.body as { data: { id: string } }).data.id)
  const prompt = await request(`/api/session/${sessionID}/prompt`, "POST", {
    id: `msg_http_no_progress_${name}`,
    prompt: { text: `Complete the private ${name} task` },
    resume: false,
  })
  assert.equal(prompt.status, 200, JSON.stringify(prompt.body))
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const locations = yield* LocationServiceMap
      const eventBridge = yield* EventV2Bridge.Service
      return yield* Effect.gen(function* () {
        const database = yield* Database.Service
        const events = yield* EventV2.Service
        const ids = yield* SessionInput.promoteSteers(database.db, events, sessionID, Number.MAX_SAFE_INTEGER)
        assert.equal(ids.length, 1)
        const activity = yield* SessionContext.Service.use((contexts) =>
          contexts.openActivity({
            sessionId: sessionID,
            triggerInputId: ids[0]!,
          }),
        ).pipe(
          Effect.provide(
            SessionContext.layer.pipe(
              Layer.provide(SessionRunnerCanonical.degradedArtifactStore),
              Layer.provide(Layer.succeed(Database.Service, database)),
            ),
          ),
        )
        const ref = { activityKind: "v2" as const, activityID: activity.activityId }
        const configured = yield* DeepAgentActivityAuthority.configure({
          ...ref,
          expectedVersion: 1,
          objectiveText: `Complete ${name}`,
          completionCriteria: [{ kind: "plan_complete" }],
          enforcementState: "monitoring",
          stallThreshold: 1,
        })
        const observe = (expectedVersion: number) =>
          DeepAgentActivityAuthority.observe({
            ...ref,
            expectedVersion,
            idempotencyKey: `${name}:observation:${expectedVersion}`,
            workspaceRevision: "private-workspace-1",
            evidence: [],
            effectReceipts: [],
            nextAction: "continue",
          })
        const first = yield* observe(configured.version)
        const stalled = yield* observe(first.objective.version)
        assert.equal(stalled.objective.state, "needs_human")
        const ownerID = yield* (yield* PermissionV2.Service).currentNoProgressOwnerID!()
        const requestID = PermissionV2.ID.make(
          `per_${Hash.sha256(`v2-no-progress:${activity.activityId}:${stalled.observation.revision}`).slice(0, 48)}`,
        )
        const metadata = {
          kind: "no_progress",
          activity_id: activity.activityId,
          observation_revision: stalled.observation.revision,
          no_progress_count: stalled.observation.noProgressCount,
          vector_hash: stalled.observation.vectorHash,
        }
        yield* DeepAgentActivityAuthority.requestPermission({
          ...ref,
          requestID,
          requestKind: "no_progress",
          idempotencyKey: `v2-no-progress-request:${requestID}`,
          permission: "doom_loop",
          patterns: ["activity"],
          alwaysPatterns: ["activity"],
          ownerID,
          metadata,
          expiresAt: Date.now() + 86_400_000,
        })
        yield* events.publish(
          PermissionV2.Event.Asked,
          { id: requestID, sessionID, action: "doom_loop", resources: ["activity"], save: ["activity"], metadata },
          { id: EventV2.ID.make(`evt_v2_permission_asked_${requestID}`) },
        )
        return {
          sessionID,
          activityID: activity.activityId,
          ownerID,
          requestID,
          projectID: (yield* Location.Service).project.id,
        }
      }).pipe(
        Effect.provide(locations.get({ directory: AbsolutePath.make(directory) })),
        Effect.provideService(EventV2.Service, EventV2.Service.of(eventBridge)),
      )
    }),
  )
}
type Challenge = Awaited<ReturnType<typeof createChallenge>>
const reply = (challenge: Challenge, decision: "once" | "reject", sessionID = challenge.sessionID) =>
  request(`/api/session/${sessionID}/permission/${challenge.requestID}/reply`, "POST", { reply: decision })
const facts = (challenge: Challenge) =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      return {
        request: yield* db.all(
          sql`SELECT * FROM session_activity_permission_request WHERE request_id=${challenge.requestID}`,
        ),
        decisions: yield* db.all(
          sql`SELECT * FROM session_activity_permission_decision WHERE request_id=${challenge.requestID}`,
        ),
        consumption: yield* db.all(
          sql`SELECT * FROM session_activity_permission_once_consumption WHERE request_id=${challenge.requestID}`,
        ),
        activities: yield* db.all<{ state: string }>(
          sql`SELECT * FROM session_activity WHERE activity_id=${challenge.activityID}`,
        ),
        objective: yield* DeepAgentActivityAuthority.reconstruct({
          activityKind: "v2",
          activityID: challenge.activityID,
        }),
        receipts: yield* db.all(
          sql`SELECT * FROM session_v2_provider_turn_receipt WHERE session_id=${challenge.sessionID}`,
        ),
        attempts: yield* db.all(sql`SELECT * FROM session_provider_attempt WHERE session_id=${challenge.sessionID}`),
        executionEvents: yield* db.all(
          sql`SELECT seq,type,data FROM event WHERE aggregate_id=${challenge.sessionID} AND type LIKE 'session.execution.%' ORDER BY seq`,
        ),
        active: Array.from(yield* (yield* SessionExecution.Service).active).filter((id) => id === challenge.sessionID),
        providerRequests: providerRequests.length,
      }
    }),
  )
async function save(name: string, value: unknown) {
  await Bun.write(path.join(root, `${name}.json`), JSON.stringify(value, null, 2))
}
function finish(response: ServerResponse, text: string) {
  response.writeHead(200, { "content-type": "text/event-stream" })
  for (const part of [
    { choices: [{ index: 0, delta: { role: "assistant" } }] },
    { choices: [{ index: 0, delta: { content: text } }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    },
  ])
    response.write(
      `data: ${JSON.stringify({ id: "chatcmpl-no-progress", object: "chat.completion.chunk", created: 1, model: "test-model", ...part })}\n\n`,
    )
  response.end("data: [DONE]\n\n")
}
try {
  const once = await createChallenge("once")
  const baseline = await facts(once)
  assert.equal(baseline.providerRequests, 0)
  const list = await request("/api/attention?kind=no_progress")
  assert.equal(list.status, 200, JSON.stringify(list.body))
  const item = (
    list.body as {
      data: { id: string; revision: string; source: { permissionRequestID: string }; allowedActions: string[] }[]
    }
  ).data.find((item) => item.source.permissionRequestID === once.requestID)
  assert(item)
  assert.deepEqual(item.allowedActions, ["continue_once", "terminate"])
  assert.equal((await request(`/api/attention/${encodeURIComponent(item.id)}`)).status, 200)
  const seen = await request(`/api/attention/${encodeURIComponent(item.id)}/seen`, "PUT", { revision: item.revision })
  assert.equal(seen.status, 200)
  assert.equal((seen.body as { data: { seen: boolean } }).data.seen, true)
  assert.equal((await request(`/api/session/${once.sessionID}/permission`)).status, 200)
  assert.deepEqual(await facts(once), baseline)
  cases.readsAndSeen = "zero_execution"
  await save("reads", { item, facts: baseline })

  const queueID = "msg_http_no_progress_future_queue"
  const queue = await request(`/api/session/${once.sessionID}/prompt`, "POST", {
    id: queueID,
    prompt: { text: "Independently queued private task" },
    delivery: "queue",
    resume: false,
  })
  assert.equal(queue.status, 200, JSON.stringify(queue.body))
  const queueFacts = () =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        return {
          inputs: yield* db.all<{ id: string; promoted_seq: number | null; delivery: string }>(
            sql`SELECT id,promoted_seq,delivery FROM session_input WHERE session_id=${once.sessionID} ORDER BY admitted_seq`,
          ),
          activities: yield* db.all<{ activity_id: string; trigger_input_id: string; state: string; delivery: string }>(
            sql`SELECT activity_id,trigger_input_id,state,delivery FROM session_activity WHERE session_id=${once.sessionID} ORDER BY ordinal`,
          ),
          members: yield* db.all<{ activity_id: string; input_id: string }>(
            sql`SELECT activity_id,input_id FROM session_activity_input WHERE input_id IN (SELECT id FROM session_input WHERE session_id=${once.sessionID}) ORDER BY input_id`,
          ),
          receipts: yield* db.all<{ activity_id: string; request_ordinal: number; state: string }>(
            sql`SELECT activity_id,request_ordinal,state FROM session_v2_provider_turn_receipt WHERE session_id=${once.sessionID} ORDER BY request_ordinal`,
          ),
        }
      }),
    )
  const admittedQueue = await queueFacts()
  assert.equal(admittedQueue.inputs.length, 2)
  assert.equal(admittedQueue.inputs[1]?.id, queueID)
  assert.equal(admittedQueue.inputs[1]?.promoted_seq, null)
  assert.equal(admittedQueue.activities.length, 1)

  const simultaneous = await Promise.all([reply(once, "once"), reply(once, "once")])
  assert.deepEqual(
    simultaneous.map((result) => result.status),
    [204, 204],
    JSON.stringify(simultaneous),
  )
  await waitFor("one gated provider request", () => providerRequests.length === 1)
  cases.simultaneousOnce = "one_provider"
  assert.equal((await reply(once, "once")).status, 204)
  assert.equal(providerRequests.length, 1)
  cases.duplicateWhileStreaming = "one_provider"
  assert.equal(responses.length, 1)
  const duringOriginal = await queueFacts()
  assert.equal(duringOriginal.inputs[1]?.promoted_seq, null)
  assert.equal(duringOriginal.activities.length, 1)
  assert.equal(duringOriginal.receipts.length, 1)
  assert.equal(duringOriginal.receipts[0]?.activity_id, once.activityID)
  assert.equal(JSON.stringify(providerRequests[0]).includes("Independently queued private task"), false)
  finish(responses[0]!, "Private task complete")
  await waitFor("original settlement wakes the independent queue provider", () => providerRequests.length === 2)
  const duringQueue = await queueFacts()
  await save("queue-before-approval", { admitted: admittedQueue, duringOriginal, duringQueue })
  assert.equal(duringQueue.inputs.length, 2)
  assert.notEqual(duringQueue.inputs[1]?.promoted_seq, null)
  assert.equal(duringQueue.activities.length, 2)
  assert.equal(duringQueue.activities[0]?.activity_id, once.activityID)
  assert.equal(duringQueue.activities[0]?.state, "settled")
  assert.equal(duringQueue.activities[1]?.trigger_input_id, queueID)
  assert.equal(duringQueue.activities[1]?.delivery, "queue")
  assert.notEqual(duringQueue.activities[1]?.activity_id, once.activityID)
  assert.equal(
    duringQueue.members.find((member) => member.input_id === queueID)?.activity_id,
    duringQueue.activities[1]?.activity_id,
  )
  assert.equal(duringQueue.receipts.length, 2)
  assert.equal(duringQueue.receipts[0]?.activity_id, once.activityID)
  assert.equal(duringQueue.receipts[1]?.activity_id, duringQueue.activities[1]?.activity_id)
  assert.equal(JSON.stringify(providerRequests[1]).includes("Independently queued private task"), true)
  finish(responses[1]!, "Independent queued task complete")
  await AppRuntime.runPromise(
    Effect.gen(function* () {
      yield* (yield* SessionExecution.Service).awaitIdle(once.sessionID)
    }),
  )
  const settled = await facts(once)
  await save("once-settled", settled)
  assert.equal(settled.decisions.length, 1)
  assert.equal(settled.consumption.length, 1)
  assert.equal(settled.receipts.length, 2)
  assert.equal(settled.activities[0]?.state, "settled")
  assert.equal((await queueFacts()).activities[1]?.state, "settled")
  cases.queueBeforeApproval = "two_distinct_activities"
  assert.equal((await reply(once, "once")).status, 204)
  await new Promise((resolve) => setTimeout(resolve, 100))
  const late = await facts(once)
  await save("late-duplicate", late)
  assert.equal(late.providerRequests, 2)
  assert.equal(late.receipts.length, 2)
  assert.equal(late.decisions.length, 1)
  assert.equal(late.consumption.length, 1)
  assert.equal(late.active.length, 0)
  assert.deepEqual(late, settled)
  cases.lateDuplicate = "two_authorized_providers"

  const beforeDrain = await createChallenge("settled-before-drain")
  const gate = { fired: false }
  const unsubscribe = await AppRuntime.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const events = yield* EventV2Bridge.Service
      return yield* events.listen((event) => {
        if (!Schema.is(SessionEvent.Execution.Started)(event) || event.data.sessionID !== beforeDrain.sessionID)
          return Effect.void
        // Started has committed its claim, but the coordinator awaits this real event observer
        // before returning from started and entering drain. No runner or authority is replaced.
        return SessionContext.Service.use((contexts) =>
          contexts.settleActivity({
            activityId: beforeDrain.activityID,
            state: "settled",
          }),
        ).pipe(
          Effect.provide(
            SessionContext.layer.pipe(
              Layer.provide(SessionRunnerCanonical.degradedArtifactStore),
              Layer.provide(Layer.succeed(Database.Service, database)),
            ),
          ),
          Effect.tap((activity) =>
            Effect.sync(() => {
              assert.equal(activity?.state, "settled")
              gate.fired = true
            }),
          ),
          Effect.orDie,
          Effect.asVoid,
        )
      })
    }),
  )
  try {
    assert.equal((await reply(beforeDrain, "once")).status, 204)
    await waitFor("actual Started observer settles original activity", () => gate.fired)
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        yield* (yield* SessionExecution.Service).awaitIdle(beforeDrain.sessionID)
      }),
    )
    const ended = await facts(beforeDrain)
    await save("settled-before-drain", ended)
    assert.equal(ended.activities[0]?.state, "settled")
    assert.equal(ended.decisions.length, 1)
    assert.equal(ended.consumption.length, 1)
    assert.equal(ended.attempts.length, 0)
    assert.equal(ended.receipts.length, 0)
    assert.equal(ended.active.length, 0)
    assert.equal(providerRequests.length, 2)
    cases.settledBeforeDrain = "zero_provider"
  } finally {
    await AppRuntime.runPromise(unsubscribe)
  }

  const rejected = await createChallenge("reject")
  assert.equal((await reply(rejected, "reject")).status, 204)
  const rejectedFacts = await facts(rejected)
  await save("reject", rejectedFacts)
  assert.equal(rejectedFacts.objective.objective.state, "interrupted")
  assert.equal(rejectedFacts.activities[0]?.state, "interrupted")
  assert.equal(rejectedFacts.receipts.length, 0)
  assert.equal(rejectedFacts.attempts.length, 0)
  assert.equal(providerRequests.length, 2)
  cases.reject = "zero_execution"

  const wrong = await createChallenge("wrong-session")
  const wrongBaseline = await facts(wrong)
  assert.equal((await reply(wrong, "once", rejected.sessionID)).status, 404)
  assert.deepEqual(await facts(wrong), wrongBaseline)
  cases.wrongSession = "zero_execution"
  assert.equal((await reply(wrong, "reject")).status, 204)

  const staleEpoch = await createChallenge("stale-epoch")
  await AppRuntime.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* PermissionSaved.Service.use((saved) =>
        saved.add({
          projectID: staleEpoch.projectID,
          action: "read",
          resources: ["private-epoch-change"],
        }),
      ).pipe(Effect.provide(PermissionSaved.layer.pipe(Layer.provide(Layer.succeed(Database.Service, database)))))
    }),
  )
  const epochBaseline = await facts(staleEpoch)
  const epochOnce = await reply(staleEpoch, "once")
  assert.equal(epochOnce.status, 404)
  assert.deepEqual(await facts(staleEpoch), epochBaseline)
  const epochAttention = await request(`/api/attention/${encodeURIComponent(`approval:${staleEpoch.requestID}`)}`)
  assert.equal(epochAttention.status, 200)
  assert.deepEqual((epochAttention.body as { data: { allowedActions: string[] } }).data.allowedActions, ["terminate"])
  const epochReject = await reply(staleEpoch, "reject")
  assert.equal(epochReject.status, 204)
  const epochStopped = await facts(staleEpoch)
  await save("stale-epoch", { once: epochOnce, attention: epochAttention, reject: epochReject, facts: epochStopped })
  assert.equal(epochStopped.objective.objective.state, "interrupted")
  assert.equal(epochStopped.activities[0]?.state, "interrupted")
  assert.equal(epochStopped.decisions.length, 1)
  assert.equal(epochStopped.consumption.length, 0)
  assert.equal(epochStopped.attempts.length, 0)
  assert.equal(epochStopped.receipts.length, 0)
  assert.equal(providerRequests.length, 2)
  cases.staleEpoch = "terminate_only_zero_execution"

  const staleOwner = await createChallenge("stale-owner")
  await AppRuntime.runPromise(
    Effect.gen(function* () {
      yield* Effect.yieldNow
      yield* DeepAgentActivityAuthority.heartbeatPermissionOwner({ ownerID: staleOwner.ownerID, leaseMs: 5 })
    }),
  )
  await waitFor("real original owner lease expiry", () =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const lease = yield* (yield* Database.Service).db
          .get<{
            live: number
          }>(
            sql`SELECT lease_expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AS live FROM session_activity_permission_owner_lease WHERE owner_id=${staleOwner.ownerID}`,
          )
          .pipe(Effect.orDie)
        return lease?.live === 0
      }),
    ),
  )
  const ownerBaseline = await facts(staleOwner)
  const ownerReplies = await Promise.all([reply(staleOwner, "once"), reply(staleOwner, "reject")])
  await save("stale-owner", { replies: ownerReplies, facts: await facts(staleOwner) })
  assert.deepEqual(
    ownerReplies.map((result) => result.status),
    [404, 404],
  )
  assert.deepEqual(await facts(staleOwner), ownerBaseline)
  cases.staleOwner = "zero_execution"
} finally {
  responses.forEach((response) => response.destroy())
  await listener.stop(true)
  await Server.disposeDefault()
  await AppRuntime.dispose()
  provider.closeAllConnections()
  await new Promise<void>((resolve) => provider.close(() => resolve()))
}
await save("result", {
  pid: process.pid,
  database: Database.path(),
  providerRequests: providerRequests.length,
  cases,
  closed: true,
})
console.log("HTTP_NO_PROGRESS_PASS", JSON.stringify(cases))
