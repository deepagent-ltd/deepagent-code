// Source-runtime oracle: the original Node Root owns SessionRunner, provider/tool
// admissions, permissions and terminal writes. This child never supplies CurrentToolExecution.
import { Server, BrowserNativeHost } from "../../../src/node"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Schema } from "effect"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { Database } from "@deepagent-code/core/database/database"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { EventV2 } from "@deepagent-code/core/event"
import { EventV2Bridge } from "../../../src/event-v2-bridge"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { BrowserControl } from "@deepagent-code/core/browser/control"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { PermissionRequestView } from "../../../../server/src/groups/permission"

const root = process.env.DAC_BROWSER_API_CANONICAL_ROOT!
const directory = path.join(root, "project")
const origin = process.env.DAC_BROWSER_API_CANONICAL_ORIGIN!
const body = '{"value":"canonical Unicode 原请求"}'
const port = Reflect.get(process, "parentPort") as {
  postMessage(value: unknown): void
  on(event: "message", callback: (event: { data: { type: string } }) => void): void
}
const held = { arrived: false }
port.on("message", (event) => {
  if (event.data.type === "api-held-arrived") held.arrived = true
})
await BrowserNativeHost.prepare()
let listener: Awaited<ReturnType<typeof Server.listen>> | undefined
let unsubscribe: EventV2.Unsubscribe | undefined
const asked: PermissionV2.Request[] = []
const permissions: Array<typeof PermissionRequestView.Type> = []
const beforeAPI: Array<{ action: string; url: string; apiActions: number; source: PermissionV2.Source;
  metadata: Record<string, unknown> }> = []
const progress: { stage: string; [key: string]: unknown } = {
  stage: "root", evidence: "source-runtime-canonical-original-root",
}
const permissionList = Schema.Struct({ data: Schema.Array(PermissionRequestView) })
const census = () => AppRuntime.runPromise(Effect.gen(function* () {
  const db = (yield* Database.Service).db
  return {
    actions: (yield* db.all<{ record: string }>("SELECT record FROM browser_action ORDER BY created_at,action_id"))
      .map((row) => Schema.decodeUnknownSync(Schema.fromJsonString(BrowserSchema.Action))(row.record)),
    admissions: yield* db.all("SELECT admission_id,receipt_id,provider_attempt_id,owner_token,session_id,tool_call_id,tool_name FROM session_v2_tool_effect_admission ORDER BY time_created,admission_id"),
    effects: yield* db.all("SELECT receipt_id,tool_call_id,state,effect_kind,error_code FROM session_v2_tool_effect ORDER BY time_created,effect_id"),
    providers: yield* db.all<{ attempt_id: string; session_id: string; selection_id: string; state: string; execution_claim_token: number; owner_token: string; error_code: string | null }>("SELECT attempt_id,session_id,selection_id,state,execution_claim_token,owner_token,error_code FROM session_provider_attempt ORDER BY created_at,attempt_id"),
    receipts: yield* db.all("SELECT receipt_id,session_id,provider_attempt_id,owner_token,state FROM session_v2_provider_turn_receipt ORDER BY request_ordinal"),
    selections: yield* db.all("SELECT selection_id,session_id,security_namespace_id,location_key,project_scope_key FROM session_context_selection ORDER BY created_at,selection_id"),
    owners: yield* db.all("SELECT owner_token,released_at FROM session_provider_owner_lease ORDER BY registered_at,owner_token"),
    inputs: yield* db.all("SELECT id,session_id,delivery,promoted_seq FROM session_input ORDER BY id"),
    activities: yield* db.all<{ activity_id: string; session_id: string; state: string }>("SELECT activity_id,session_id,state FROM session_activity ORDER BY created_at,activity_id"),
    messages: yield* db.all("SELECT id,type,data FROM session_message ORDER BY session_id,seq"),
    work: yield* db.all("SELECT work_id FROM work_execution"),
    counts: yield* db.all("SELECT acquisition_id FROM work_count_acquisition"),
    saved: yield* db.all("SELECT * FROM permission"),
  }
}))

async function request(route: string, payload?: unknown) {
  assert(listener)
  const response = await fetch(new URL(route, listener.url), {
    method: payload === undefined ? "GET" : "POST",
    headers: { authorization: `Basic ${Buffer.from("deepagent-code:private-fixture").toString("base64")}`,
      "content-type": "application/json", "x-deepagent-code-directory": directory, connection: "close" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(10_000),
  })
  if (response.status === 204) return undefined
  const value: unknown = await response.json()
  assert.equal(response.status, 200, `${route}: ${JSON.stringify(value)}`)
  return value
}

try {
  // Server.listen adopts the application's already-built Root memo map and file DB.
  await AppRuntime.runPromise(Database.Service)
  listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  unsubscribe = await AppRuntime.runPromise(Effect.gen(function* () {
    return yield* (yield* EventV2Bridge.Service).listen((event) => Effect.sync(() => {
      if (event.type === PermissionV2.Event.Asked.type)
        asked.push(Schema.decodeUnknownSync(PermissionV2.Request)(event.data))
    }))
  }))
  progress.stage = "create-session"
  const session = await AppRuntime.runPromise(SessionV2.Service.use((sessions) => sessions.create({
    location: { directory: AbsolutePath.make(directory) },
    model: { providerID: ProviderV2.ID.make("fixture"), id: ModelV2.ID.make("test-model") },
    permissions: [{ action: "*", resource: "*", effect: "deny" },
      { action: "browser", resource: "*", effect: "ask" },
      { action: "browser-api-post", resource: "*", effect: "ask" }],
  })))
  progress.session = session.id
  progress.stage = "create-control"
  const created = Schema.decodeUnknownSync(BrowserSchema.ControlView)(await request("/api/v1/browser/controls", {
    requestID: "api-canonical-control-create", sessionID: session.id, profile: BrowserSchema.API_POST_PROFILE,
    origin, approvedOrigins: [origin], resolverPolicy: "cloudflare_doh_v1", pageMode: "static",
    apiPostTargets: [origin + "/api?request=canonical", origin + "/held"].map((url) => ({
      url, contentTypes: ["application/json"], maxBodyBytes: 65536,
    })), expiresAt: Date.now() + 90_000,
  }))
  assert.equal(created.nativeVerification, "verified")
  assert.equal(created.control.state, "active")
  progress.control = created.control
  port.postMessage({ type: "canonical-control", controlID: created.control.controlID })

  // Both asks are serial original leaf authorizations. Neither pending request
  // can be replaced by a constructed permit, admission, action or provider receipt.
  const approve = async (url?: string) => {
    const pending = Schema.decodeUnknownSync(permissionList)(await request(`/api/session/${session.id}/permission`))
    for (const item of pending.data) {
      if (permissions.some((prior) => prior.id === item.id)) continue
      assert(["browser", "browser-api-post"].includes(item.action), JSON.stringify(item))
      assert.equal(item.sessionID, session.id)
      assert(item.source?.type === "tool")
      assert(item.resources.every((value) => value.startsWith(created.control.controlID + "/")))
      const published = asked.find((value) => value.id === item.id)
      assert(published)
      assert.equal(published.sessionID, item.sessionID)
      assert.equal(published.action, item.action)
      assert.deepEqual(published.resources, item.resources)
      assert.deepEqual(published.metadata, item.metadata)
      assert.deepEqual(published.source, item.source)
      if (item.metadata?.operation === "api.post") {
        assert(url)
        const observed = await census()
        const snapshot = observed.actions.find((value) => value.command.type === "snapshot")
        assert(snapshot?.command.type === "snapshot" && snapshot.result?.frameID && snapshot.result.observationRevision)
        const command = { type: "api.post", actionTag: BrowserSchema.API_POST_ACTION_TAG, profileVersion: 1,
          tabID: snapshot.command.tabID, generation: snapshot.command.generation,
          frameID: snapshot.result.frameID, observationRevision: snapshot.result.observationRevision,
          url, contentType: "application/json", body } satisfies Extract<BrowserSchema.Command, { type: "api.post" }>
        assert.deepEqual(item.metadata, { origin, operation: "api.post", controlID: created.control.controlID,
          ...BrowserSchema.apiPostMetadata(command) })
        assert.deepEqual(item.resources, [`${created.control.controlID}/api.post/${command.tabID}/${BrowserControl.hash(command)}`])
        assert.equal(item.source.callID, url.endsWith("/held") ? "api_canonical_call_6" : "api_canonical_call_4")
        const prior = permissions.find((value) => value.metadata?.url === url)
        if (prior) { assert.equal(prior.action, "browser"); assert.equal(item.action, "browser-api-post");
          assert.deepEqual(prior.source, item.source); assert.deepEqual(prior.resources, item.resources);
          assert.deepEqual(prior.metadata, item.metadata) }
        const apiActions = observed.actions.filter((value) => value.command.type === "api.post" && value.command.url === url).length
        assert.equal(apiActions, 0)
        beforeAPI.push({ action: item.action, url, apiActions, source: item.source, metadata: item.metadata })
        port.postMessage({ type: "canonical-api-pending", action: item.action, url })
      }
      permissions.push(item)
      await request(`/api/session/${session.id}/permission/${item.id}/reply`, { reply: "once" })
    }
  }
  const positivePrompt = { id: "msg_api_canonical_positive", prompt: { text: "Send the exact explicitly approved public API request once." } }
  progress.stage = "positive-prompt"
  await request(`/api/session/${session.id}/prompt`, positivePrompt)
  const positiveDeadline = Date.now() + 45_000
  for (;;) {
    assert(Date.now() < positiveDeadline, `Canonical boundary timed out at ${progress.stage}`)
    await approve(origin + "/api?request=canonical")
    const state = await census()
    assert(!state.providers.some((value) => ["failed", "indeterminate_after_crash"].includes(String(value.state))),
      `Original provider stopped: ${JSON.stringify(state.providers)}`)
    if (state.activities.some((value) => value.state === "settled")) break
    assert(!state.activities.some((value) => ["failed", "interrupted"].includes(String(value.state))))
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  await AppRuntime.runPromise(SessionExecution.Service.use((execution) => execution.awaitIdle(SessionSchema.ID.make(session.id))))
  progress.positive = await census()
  progress.stage = "exact-prompt-retry"
  const beforeRetry = await census()
  await request(`/api/session/${session.id}/prompt`, positivePrompt)
  await AppRuntime.runPromise(SessionExecution.Service.use((execution) => execution.awaitIdle(SessionSchema.ID.make(session.id))))
  const afterRetry = await census()
  assert.deepEqual(afterRetry, beforeRetry)
  progress.retry = { unchanged: true, before: beforeRetry, after: afterRetry }

  progress.stage = "held-prompt"
  await request(`/api/session/${session.id}/prompt`, {
    id: "msg_api_canonical_held", prompt: { text: "Send the exact explicitly approved held API request once; do not repeat an unknown result." },
  })
  const heldDeadline = Date.now() + 25_000
  while (!held.arrived) {
    assert(Date.now() < heldDeadline, "The original API request never physically arrived")
    await approve(origin + "/held")
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  assert.deepEqual(permissions.filter((value) => value.metadata?.url === origin + "/held").map((value) => value.action),
    ["browser", "browser-api-post"])
  progress.stage = "cancel-after-physical-dispatch"
  const beforeCancel = Schema.decodeUnknownSync(BrowserSchema.ControlView)(
    await request(`/api/v1/browser/controls/${created.control.controlID}`))
  const stopped = Schema.decodeUnknownSync(BrowserSchema.ControlView)(await request(
    `/api/v1/browser/controls/${created.control.controlID}/cancel`, {
      requestID: "api-canonical-control-close", expectedRevision: beforeCancel.control.revision,
    }))
  assert.equal(stopped.stopConfirmed, true)
  assert.equal(stopped.control.state, "stopped")
  progress.stopped = stopped
  // Observe the original runner's actual outcome. A stopped/unknown provider is
  // never repaired by SQL or represented as a fabricated successful turn.
  const idle = await AppRuntime.runPromise(SessionExecution.Service.use((execution) =>
    execution.awaitIdle(SessionSchema.ID.make(session.id))).pipe(Effect.exit))
  progress.unknownIdle = Exit.isSuccess(idle) ? { outcome: "success" } : { outcome: "failure", cause: Cause.pretty(idle.cause) }
  progress.facts = await census()
  progress.permissions = permissions
  progress.asked = asked
  progress.beforeAPI = beforeAPI
  progress.stage = "complete"
} catch (error) {
  progress.error = error instanceof Error ? error.stack : String(error)
  progress.permissions = permissions
  progress.asked = asked
  progress.beforeAPI = beforeAPI
  progress.facts = await census().catch((error) => ({ censusError: String(error) }))
} finally {
  if (unsubscribe) await AppRuntime.runPromise(unsubscribe)
  await listener?.stop()
  await AppRuntime.dispose()
  await fs.writeFile(path.join(root, "child-result.json"), JSON.stringify(progress, null, 2), { mode: 0o600 })
  port.postMessage({ type: "canonical-result", succeeded: progress.stage === "complete" })
}
