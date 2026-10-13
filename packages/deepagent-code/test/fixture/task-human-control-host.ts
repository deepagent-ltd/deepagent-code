import assert from "node:assert/strict"
import path from "node:path"
import { eq, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { AttentionSchema } from "@deepagent-code/core/attention/schema"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionStore } from "@deepagent-code/core/session/store"
import { TaskRunTable } from "@deepagent-code/core/session/sql"
import { TaskRunAuthority } from "@deepagent-code/core/session/task-run"
import { TaskHumanControlSchema } from "@deepagent-code/core/session/task-human-control.schema"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { AppRuntime } from "@/effect/app-runtime"
import { Server } from "@/server/server"

const root = process.argv[2]!
const directory = path.join(root, "project")
const authorization = `Basic ${Buffer.from("deepagent-code:task-human-control-fixture").toString("base64")}`
const cleanup = { listenerClosed: false, runtimeDisposed: false }
const state: { listener?: Awaited<ReturnType<typeof Server.listen>> } = {}
const census = () =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      return yield* db.all(sql`SELECT (SELECT count(*) FROM task_run_event) AS events,
    (SELECT coalesce(sum(version),0) FROM task_run) AS versions,(SELECT count(*) FROM session_v2_task_run_receipt) AS terminals,
    (SELECT count(*) FROM task_notification_outbox) AS outbox,(SELECT count(*) FROM session_input) AS inputs,
    (SELECT count(*) FROM session_v2_provider_turn_receipt) AS providers,
    (SELECT count(*) FROM session WHERE execution_claim_token IS NOT NULL) AS claims`)
    }),
  )
const request = async (
  input: TaskHumanControlSchema.Input,
  options: { status?: number; headers?: Record<string, string>; query?: string } = {},
) => {
  assert(state.listener)
  const response = await fetch(new URL(`/api/attention/task/control${options.query ?? ""}`, state.listener.url), {
    method: "POST",
    headers: { authorization, "content-type": "application/json", ...options.headers },
    body: JSON.stringify(input),
  })
  const body: unknown = await response.json()
  assert.equal(response.status, options.status ?? 200, JSON.stringify(body))
  return body
}
const item = async (id: string) => {
  assert(state.listener)
  const response = await fetch(new URL(`/api/attention/${encodeURIComponent(id)}`, state.listener.url), {
    headers: { authorization },
  })
  assert.equal(response.status, 200)
  return Schema.decodeUnknownSync(Schema.Struct({ data: AttentionSchema.Item }))(await response.json()).data
}
const advertisements: { source: string; actions: string[]; unchanged: boolean; seen: boolean; denied: number }[] = []
const observe = async (task: TaskRunAuthority.Run, expected: string[]) => {
  assert(state.listener)
  const id = `task:${task.childSessionID}:${task.generation}`
  const before = await census()
  const current = await item(id)
  assert.deepEqual(current.allowedActions, expected)
  const listed = await fetch(new URL("/api/attention?kind=task", state.listener.url), { headers: { authorization, origin: "oc://renderer" } })
  assert.equal(listed.status, 200)
  const page = Schema.decodeUnknownSync(AttentionSchema.List)(await listed.json())
  assert.deepEqual(page.data.find((entry) => entry.id === id)?.allowedActions, expected)
  const seen = await fetch(new URL(`/api/attention/${encodeURIComponent(id)}/seen`, state.listener.url), {
    method: "PUT", headers: { authorization, origin: "oc://renderer", "content-type": "application/json" },
    body: JSON.stringify({ revision: current.revision }),
  })
  assert.equal(seen.status, 200)
  const viewed = Schema.decodeUnknownSync(Schema.Struct({ data: AttentionSchema.Item }))(await seen.json()).data
  assert(viewed.seen)
  assert.equal(viewed.revision, current.revision)
  assert.deepEqual(viewed.allowedActions, expected)
  const challenges: Array<{ headers: Record<string, string>; query: string }> = [
    { headers: { authorization, origin: "https://foreign.example" }, query: "" },
    { headers: { authorization }, query: `?auth_token=${encodeURIComponent(Buffer.from("deepagent-code:task-human-control-fixture").toString("base64"))}` },
  ]
  for (const challenge of challenges) {
    const response: Response = await fetch(new URL(`/api/attention/${encodeURIComponent(id)}${challenge.query}`, state.listener.url), { headers: challenge.headers })
    assert.equal(response.status, 200)
    const facts = Schema.decodeUnknownSync(Schema.Struct({ data: AttentionSchema.Item }))(await response.json()).data
    assert.equal(facts.revision, current.revision)
    assert.deepEqual(facts.source, current.source)
    assert.deepEqual(facts.allowedActions, [])
  }
  const unchanged = JSON.stringify(await census()) === JSON.stringify(before)
  assert(unchanged, "GET/list/seen changed task execution census")
  advertisements.push({ source: current.reasonCode, actions: expected, unchanged, seen: viewed.seen, denied: challenges.length })
}
const command = async (task: TaskRunAuthority.Run, requestID: string, action: TaskHumanControlSchema.Action) => {
  const current = await item(`task:${task.childSessionID}:${task.generation}`)
  assert(current.source.task)
  return {
    runID: task.runID,
    parentSessionID: task.parentSessionID,
    childSessionID: current.source.task.childSessionID,
    generation: task.generation,
    expectedVersion: current.source.task.version,
    itemID: current.id,
    itemRevision: current.revision,
    requestID,
    action,
    reason: "Human control of an original registered Task",
  }
}

try {
  await AppRuntime.runPromise(Database.Service)
  state.listener = await Server.listen({ hostname: "127.0.0.1", port: 0, cors: ["https://explicit-operator.example"] })
  const parent = await AppRuntime.runPromise(
    SessionV2.Service.use((sessions) => sessions.create({ location: { directory: AbsolutePath.make(directory) } })),
  )
  const original = await AppRuntime.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const spec: TaskRunAuthority.SubmitSpec = {
        parentSessionID: parent.id,
        parentMessageID: SessionMessage.ID.make("msg_human_control_known"),
        toolCallID: "call_human_control_known",
        prompt: new Prompt({ text: "Known task before dispatch" }),
        deliveryMode: "foreground",
        agent: "general",
        child: {
          title: "Known task before dispatch",
          location: { directory: AbsolutePath.make(directory) },
          permissions: [],
        },
      }
      const admitted = yield* TaskRunAuthority.admitRun(db, spec)
      // A nonterminal crash frontier, with no child/provider/tool/owner. Settlement is produced by the original reducer below.
      yield* db
        .update(TaskRunTable)
        .set({ state: "recovery_required" })
        .where(eq(TaskRunTable.run_id, admitted.run.runID))
        .run()
        .pipe(Effect.orDie)
      return admitted.run
    }),
  )
  await observe(original, ["task_request_close", "task_resolve_failed", "task_resolve_closed"])
  const close = await command(original, "http-known-close", "resolve_closed")
  assert.equal(close.childSessionID, null)
  const denied: { kind: string; unchanged: boolean }[] = []
  const challenges: Array<{ kind: string; status: number; headers?: Record<string, string>; query?: string }> = [
    { kind: "wrong-basic", status: 401, headers: { authorization: "Basic invalid" } },
    { kind: "foreign-origin", status: 401, headers: { origin: "https://foreign.example" } },
    { kind: "convenient-localhost-origin", status: 401, headers: { origin: "http://localhost:31337" } },
    { kind: "renderer-prefix-spoof", status: 401, headers: { origin: "oc://renderer.attacker" } },
    {
      kind: "query-token",
      status: 401,
      query: `?auth_token=${encodeURIComponent(Buffer.from("deepagent-code:task-human-control-fixture").toString("base64"))}`,
    },
    { kind: "workspace-selector", status: 400, query: "?workspace=wrk_foreign" },
  ]
  for (const challenge of challenges) {
    const before = await census()
    await request(close, challenge)
    const unchanged = JSON.stringify(await census()) === JSON.stringify(before)
    assert(unchanged, challenge.kind)
    denied.push({ kind: challenge.kind, unchanged })
  }
  const known = Schema.decodeUnknownSync(TaskHumanControlSchema.Result)(
    await request(close, { headers: { origin: state.listener.url.origin } }),
  )
  assert.equal(known.receipt.authority.principal, "server:deepagent-code")
  assert.equal(known.receipt.state, "closed")
  assert.equal(known.receipt.request.childSessionID, null)
  assert(known.receipt.terminalReceiptID)
  const beforeRetry = await census()
  const client = createDeepAgentCodeClient({
    baseUrl: state.listener.url.toString(),
    headers: { authorization, origin: "oc://renderer" },
  })
  const retry = await client.v2.attention.taskControl({ taskHumanControlInput: close }, { throwOnError: true })
  assert.deepEqual(retry.data, { receipt: known.receipt, replayed: true })
  assert.deepEqual(await census(), beforeRetry)
  await request({ ...close, reason: "Conflicting reuse" }, { status: 409 })
  assert.deepEqual(await census(), beforeRetry)
  const unknown = await AppRuntime.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const submitted = yield* TaskRunAuthority.submit(db, yield* EventV2Bridge.Service, yield* SessionV2.Service, {
        parentSessionID: parent.id,
        parentMessageID: SessionMessage.ID.make("msg_human_control_unknown"),
        toolCallID: "call_human_control_unknown",
        prompt: new Prompt({ text: "An original child input with unresolved ownership" }),
        deliveryMode: "foreground",
        agent: "general",
        child: {
          title: "Unknown task ownership",
          location: { directory: AbsolutePath.make(directory) },
          permissions: [],
        },
      })
      yield* db
        .update(TaskRunTable)
        .set({ state: "recovery_required", phase: "research" })
        .where(eq(TaskRunTable.run_id, submitted.run.runID))
        .run()
        .pipe(Effect.orDie)
      const token = yield* (yield* SessionStore.Service).claim(submitted.run.childSessionID)
      assert(token)
      return { task: submitted.run, token }
    }),
  )
  await observe(unknown.task, ["task_request_close"])
  const resolution = await command(unknown.task, "http-unknown-resolution", "resolve_failed")
  const beforeUnknown = await census()
  await request(resolution, { status: 409 })
  assert.deepEqual(await census(), beforeUnknown)
  const intent = Schema.decodeUnknownSync(TaskHumanControlSchema.Result)(
    await request(await command(unknown.task, "http-unknown-close", "request_close"), {
      headers: { origin: "https://explicit-operator.example" },
    }),
  )
  assert.equal(intent.receipt.state, "recovery_required")
  assert.equal(intent.receipt.controlState, "close_requested")
  assert.equal(intent.receipt.terminalReceiptID, null)
  assert.equal(intent.receipt.request.childSessionID, unknown.task.childSessionID)
  const actual = await AppRuntime.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const row = yield* db
        .select({ settled: TaskRunTable.time_settled, state: TaskRunTable.state })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, unknown.task.runID))
        .get()
      assert.equal(row?.settled, null)
      return {
        claim: yield* (yield* SessionStore.Service).claimToken(unknown.task.childSessionID),
        providers: (yield* db.all<{ n: number }>("SELECT count(*) AS n FROM session_v2_provider_turn_receipt"))[0].n,
        controls: (yield* db.all<{ n: number }>(
          "SELECT count(*) AS n FROM task_run_event WHERE event_id LIKE 'evthuman_%'",
        ))[0].n,
      }
    }),
  )
  assert.equal(actual.claim, unknown.token)
  assert.equal(actual.providers, 0)
  assert.equal(actual.controls, 2)
  const result = {
    known: { state: known.receipt.state, nullChild: known.receipt.request.childSessionID === null },
    exactRetry: retry.data.replayed,
    unknown: {
      state: intent.receipt.state,
      controlState: intent.receipt.controlState,
      claimRetained: actual.claim === unknown.token,
    },
    denied,
    advertisements,
    providers: actual.providers,
    taskControlReceipts: actual.controls,
    cleanup,
  }
  await state.listener.stop(true)
  cleanup.listenerClosed = true
  await Server.disposeDefault()
  await AppRuntime.dispose()
  cleanup.runtimeDisposed = true
  await Bun.write(path.join(root, "result.json"), JSON.stringify(result))
  console.log(`TASK_HUMAN_CONTROL_HOST_OK ${root}`)
} finally {
  if (!cleanup.listenerClosed && state.listener) await state.listener.stop(true)
  await Server.disposeDefault()
  if (!cleanup.runtimeDisposed) await AppRuntime.dispose()
}
