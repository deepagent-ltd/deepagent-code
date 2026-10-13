// Source-runtime oracle. Session admission, provider ownership, tool admission and permissions
// belong to the original application Root; this fixture never supplies CurrentToolExecution.
import { Server, BrowserNativeHost } from "../../../src/node"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { Database } from "@deepagent-code/core/database/database"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { Hash } from "@deepagent-code/core/util/hash"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { AbsolutePath } from "@deepagent-code/core/schema"

const root = process.env.DAC_BROWSER_TEST_ROOT!
const directory = path.join(root, "project")
const source =
  "return {version:1,steps:[{type:'fill',target:'name',text:args.text},{type:'select',target:'choice',values:['b']},{type:'click',target:'submit',waitForNavigation:true}]};"
const argsJSON = '{"text":"canonical program value"}'
const port = Reflect.get(process, "parentPort") as {
  postMessage(value: unknown): void
  on(event: "message", callback: (event: { data: { type: string } }) => void): void
}
await BrowserNativeHost.prepare()
let listener: Awaited<ReturnType<typeof Server.listen>> | undefined
const progress: { stage: string; [key: string]: unknown } = {
  stage: "root",
  evidence: "source-runtime-canonical-original-root",
}
// Read the public fields used by this oracle. Optional wire fields are not the internal
// Request codec; none of them is used to create or replace a permission capability.
const permissionList = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: PermissionV2.ID,
      sessionID: SessionSchema.ID,
      action: Schema.String,
      resources: Schema.Array(Schema.String),
      source: PermissionV2.Source,
    }),
  ),
})
const census = () =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      return {
        actions: (yield* db.all<{ record: string }>(
          "SELECT record FROM browser_action ORDER BY created_at,action_id",
        )).map((row) => Schema.decodeUnknownSync(Schema.fromJsonString(BrowserSchema.Action))(row.record)),
        admissions: yield* db.all(
          "SELECT admission_id,receipt_id,provider_attempt_id,owner_token,session_id,tool_call_id,tool_name FROM session_v2_tool_effect_admission ORDER BY time_created,admission_id",
        ),
        effects: yield* db.all(
          "SELECT receipt_id,tool_call_id,state,effect_kind FROM session_v2_tool_effect ORDER BY time_created,effect_id",
        ),
        providers: yield* db.all(
          "SELECT attempt_id,session_id,selection_id,state,execution_claim_token,owner_token FROM session_provider_attempt ORDER BY created_at,attempt_id",
        ),
        receipts: yield* db.all(
          "SELECT receipt_id,session_id,provider_attempt_id,owner_token,state FROM session_v2_provider_turn_receipt ORDER BY request_ordinal",
        ),
        selections: yield* db.all(
          "SELECT selection_id,session_id,security_namespace_id,location_key,project_scope_key FROM session_context_selection ORDER BY created_at,selection_id",
        ),
        owners: yield* db.all(
          "SELECT owner_token,released_at FROM session_provider_owner_lease ORDER BY registered_at,owner_token",
        ),
        inputs: yield* db.all("SELECT id,session_id,delivery,promoted_seq FROM session_input ORDER BY id"),
        work: yield* db.all("SELECT work_id FROM work_execution"),
        counts: yield* db.all("SELECT acquisition_id FROM work_count_acquisition"),
        saved: yield* db.all("SELECT * FROM permission"),
      }
    }),
  )

async function request(route: string, body?: unknown) {
  assert(listener)
  const url = new URL(route, listener.url)
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Basic ${Buffer.from("deepagent-code:private-fixture").toString("base64")}`,
      "content-type": "application/json",
      "x-deepagent-code-directory": directory,
      connection: "close",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  })
  if (response.status === 204) return undefined
  const value: unknown = await response.json()
  assert.equal(response.status, 200, `${route}: ${JSON.stringify(value)}`)
  return value
}

try {
  // Build the one application Root first; Server.listen must adopt its actual memo map and DB.
  await AppRuntime.runPromise(Database.Service)
  listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  progress.stage = "create-session"
  const session = await AppRuntime.runPromise(
    SessionV2.Service.use((sessions) =>
      sessions.create({
        location: { directory: AbsolutePath.make(directory) },
        model: { providerID: ProviderV2.ID.make("fixture"), id: ModelV2.ID.make("test-model") },
        permissions: [
          { action: "*", resource: "*", effect: "deny" },
          { action: "plan", resource: "*", effect: "allow" },
          { action: "browser", resource: "*", effect: "ask" },
          { action: "browser-program", resource: "*", effect: "ask" },
        ],
      }),
    ),
  )
  progress.stage = "create-control"
  const created = Schema.decodeUnknownSync(BrowserSchema.ControlView)(
    await request("/api/v1/browser/controls", {
      requestID: "canonical-control-create",
      sessionID: session.id,
      profile: BrowserSchema.INTERACTION_PROFILE,
      origin: process.env.DAC_BROWSER_ORIGIN!,
      postPaths: ["/program-submit"],
      expiresAt: Date.now() + 90_000,
      programGrants: [
        {
          scriptHash: Hash.sha256(source),
          argsHash: Hash.sha256(argsJSON),
          operations: ["fill", "select", "click"],
          maxSteps: 3,
        },
      ],
    }),
  )
  assert.equal(created.nativeVerification, "verified")
  assert.equal(created.control.state, "active")
  progress.control = created.control
  port.postMessage({ type: "canonical-control", controlID: created.control.controlID, source, argsJSON })
  progress.stage = "original-prompt"
  await request(`/api/session/${session.id}/prompt`, {
    id: "msg_program_canonical_input",
    prompt: { text: "Run only the explicitly approved browser plan in this control." },
  })
  const permissions: PermissionV2.Request[] = []
  const beforeProgram: unknown[] = []
  progress.stage = "original-permissions"
  const deadline = Date.now() + 50_000
  for (;;) {
    assert(Date.now() < deadline, `Canonical boundary timed out at ${progress.stage}`)
    const pending = Schema.decodeUnknownSync(permissionList)(await request(`/api/session/${session.id}/permission`))
    for (const item of pending.data) {
      if (permissions.some((prior) => prior.id === item.id)) continue
      assert(["browser", "browser-program"].includes(item.action), JSON.stringify(item))
      assert.equal(item.source?.type, "tool")
      assert.equal(item.sessionID, session.id)
      assert(item.resources.every((value) => value.startsWith(created.control.controlID + "/")))
      if (item.resources.some((value) => value.includes("/program/"))) {
        const observed = await census()
        assert.equal(observed.actions.filter((value) => value.command.type === "program").length, 0)
        beforeProgram.push({
          action: item.action,
          actions: observed.actions.length,
          programActions: 0,
          resource: item.resources,
          source: item.source,
        })
        port.postMessage({ type: "canonical-program-pending", action: item.action })
      }
      permissions.push(item)
      await request(`/api/session/${session.id}/permission/${item.id}/reply`, { reply: "once" })
    }
    const state = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const failed = yield* db.get<{ state: string; error_code: string | null }>(
          "SELECT state,error_code FROM session_provider_attempt WHERE state IN ('failed','indeterminate_after_crash') ORDER BY created_at DESC LIMIT 1",
        )
        assert(!failed, `Original provider stopped: ${JSON.stringify(failed)}`)
        return yield* db.get<{ state: string }>("SELECT state FROM session_activity ORDER BY created_at DESC LIMIT 1")
      }),
    )
    if (state?.state === "settled") break
    assert(!state || !["failed", "interrupted"].includes(state.state), `Original activity ended ${state?.state}`)
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  await AppRuntime.runPromise(
    SessionExecution.Service.use((execution) => execution.awaitIdle(SessionSchema.ID.make(session.id))),
  )
  progress.stage = "original-receipts"
  progress.permissions = permissions
  progress.beforeProgram = beforeProgram
  progress.facts = await census()
  const beforeCancel = Schema.decodeUnknownSync(BrowserSchema.ControlView)(
    await request(`/api/v1/browser/controls/${created.control.controlID}`),
  )
  const stopped = Schema.decodeUnknownSync(BrowserSchema.ControlView)(
    await request(`/api/v1/browser/controls/${created.control.controlID}/cancel`, {
      requestID: "canonical-control-close",
      expectedRevision: beforeCancel.control.revision,
    }),
  )
  assert.equal(stopped.stopConfirmed, true)
  assert.equal(stopped.control.state, "stopped")
  progress.stopped = stopped
  progress.stage = "complete"
} catch (error) {
  progress.error = error instanceof Error ? error.stack : String(error)
  progress.facts = await census().catch((error) => ({ censusError: String(error) }))
} finally {
  await listener?.stop()
  await AppRuntime.dispose()
  await fs.writeFile(path.join(root, "child-result.json"), JSON.stringify(progress, null, 2), { mode: 0o600 })
  port.postMessage({ type: "canonical-result", succeeded: progress.stage === "complete" })
}
