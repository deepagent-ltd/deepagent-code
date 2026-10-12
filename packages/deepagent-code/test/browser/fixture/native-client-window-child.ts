// NativeBootstrap remains the original first dependency. Nothing in this fixture
// supplies CurrentToolExecution, permissions, provider admissions or terminal rows.
import { Server, BrowserNativeHost } from "../../../src/node"
import fs from "node:fs/promises"
import path from "node:path"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { Database } from "@deepagent-code/core/database/database"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { Effect, Schema } from "effect"
import assert from "node:assert/strict"

const root = process.env.DAC_BROWSER_CLIENT_ROOT!
const directory = path.join(root, "project")
const source = process.env.DAC_BROWSER_CLIENT_PROGRAM!
const argsJSON = "null"
const originalPort = Reflect.get(process, "parentPort") as { postMessage(value: unknown): void }
await BrowserNativeHost.prepare()
const state = { stage: "root", listener: undefined as Awaited<ReturnType<typeof Server.listen>> | undefined,
  sessions: [] as string[], succeeded: false, failureClass: "", before: undefined as unknown, after: undefined as unknown }

const census = () => AppRuntime.runPromise(Effect.gen(function* () {
  const db = (yield* Database.Service).db
  return {
    inputs: yield* db.all("SELECT id,session_id,delivery,promoted_seq FROM session_input ORDER BY id"),
    actions: yield* db.all<{ record: string }>("SELECT record FROM browser_action ORDER BY created_at,action_id"),
    controls: yield* db.all<{ record: string }>("SELECT record FROM browser_control ORDER BY control_id"),
    admissions: yield* db.all("SELECT admission_id,receipt_id,provider_attempt_id,owner_token,session_id,tool_call_id,tool_name FROM session_v2_tool_effect_admission ORDER BY time_created,admission_id"),
    effects: yield* db.all<{ state: string }>("SELECT receipt_id,tool_call_id,state,effect_kind FROM session_v2_tool_effect ORDER BY time_created,effect_id"),
    providers: yield* db.all<{ state: string }>("SELECT attempt_id,session_id,selection_id,state,owner_token,error_code FROM session_provider_attempt ORDER BY created_at,attempt_id"),
    receipts: yield* db.all("SELECT receipt_id,session_id,provider_attempt_id,owner_token,state FROM session_v2_provider_turn_receipt ORDER BY request_ordinal"),
    permissions: yield* db.all("SELECT * FROM permission"),
    work: yield* db.all("SELECT work_id FROM work_execution"),
    counts: yield* db.all("SELECT acquisition_id FROM work_count_acquisition"),
  }
}))

try {
  await AppRuntime.runPromise(Database.Service)
  state.listener = await Server.listen({ hostname: "127.0.0.1", port: 0, cors: [process.env.DAC_BROWSER_CLIENT_APP_ORIGIN!] })
  assert(BrowserNativeHost.current()?.alive(), "Original Main/utility Native handshake is required")
  state.stage = "original_sessions"
  for (const client of ["gui", "tui"] as const) {
    const session = await AppRuntime.runPromise(SessionV2.Service.use((sessions) => sessions.create({
      location: { directory: AbsolutePath.make(directory) },
      model: { providerID: ProviderV2.ID.make("fixture"), id: ModelV2.ID.make("test-model") },
      title: `Canonical browser ${client}`,
      permissions: [{ action: "*", resource: "*", effect: "deny" },
        { action: "browser", resource: "*", effect: "ask" },
        { action: "browser-program", resource: "*", effect: "ask" }],
    })))
    state.sessions.push(session.id)
  }
  state.before = await census()
  const before = state.before as Awaited<ReturnType<typeof census>>
  assert.equal(before.controls.length, 0)
  assert.equal(before.inputs.length, 0)
  assert.equal(before.providers.length, 0)
  assert.equal(before.admissions.length, 0)
  const { Hash } = await import("@deepagent-code/core/util/hash")
  await fs.writeFile(path.join(root, "client-window-private.json"), JSON.stringify({
    version: 1, evidence: "source-runtime-canonical-client-hold-window", rootURL: state.listener.url.origin,
    appOrigin: process.env.DAC_BROWSER_CLIENT_APP_ORIGIN!, authorizationFile: path.join(root, "authorization"),
    directory, output: root, deadlineAt: Number(process.env.DAC_BROWSER_CLIENT_DEADLINE),
    sessions: { gui: state.sessions[0], tui: state.sessions[1] }, pageOrigin: process.env.DAC_BROWSER_CLIENT_PAGE_ORIGIN!,
    postPath: "/program-submit", program: { source, argsJSON, scriptHash: Hash.sha256(source), argsHash: Hash.sha256(argsJSON),
      operations: ["fill", "select", "click"], maxSteps: 3 },
    model: { providerID: "fixture", modelID: "test-model" }, expectedProviderTurnsPerClient: 5,
    stopFile: path.join(root, "client-window-stop"),
  }, null, 2), { mode: 0o600 })
  state.stage = "hold_ready"
  originalPort.postMessage({ type: "client-window-ready", rootURL: state.listener.url.origin })
  const deadline = Number(process.env.DAC_BROWSER_CLIENT_DEADLINE)
  while (Date.now() < deadline && !(await fs.stat(path.join(root, "client-window-stop")).then((value) => value.isFile()).catch(() => false)))
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
  state.stage = "original_census"
  state.after = await census()
  const after = state.after as Awaited<ReturnType<typeof census>>
  const controls = after.controls.map((row) => Schema.decodeUnknownSync(Schema.fromJsonString(BrowserSchema.Control))(row.record))
  const expected = Number(process.env.DAC_BROWSER_CLIENT_EXPECTED_CLIENTS)
  assert([0, 1, 2].includes(expected), "The parent fixes the bounded QA consumer count")
  if (after.inputs.length) {
    assert.equal(after.inputs.length, expected, "Exactly one original client prompt per participating Session")
    assert.equal(after.controls.length, expected, "Each client must create its own formal control")
    assert.equal(after.providers.length, expected * 5)
    assert.equal(after.admissions.length, expected * 4)
    assert.equal(after.actions.length, expected * 4)
    assert(after.providers.every((row) => row.state === "settled"))
    assert(after.effects.every((row) => row.state === "settled"))
    const actions = after.actions.map((row) => Schema.decodeUnknownSync(Schema.fromJsonString(BrowserSchema.Action))(row.record))
    assert.equal(actions.filter((row) => row.command.type === "program" && row.outcome === "completed" && row.result?.program?.completedSteps === 3).length, expected)
    assert(controls.every((control) => control.state === "stopped"))
  }
  if (!after.inputs.length) assert.equal(after.controls.length, 0, "Startup/stop does not approve or execute")
  assert.equal(after.work.length, 0)
  assert.equal(after.counts.length, 0)
  assert.equal(after.permissions.length, 0, "All permission replies are once; no saved grants")
  state.succeeded = true
  state.stage = "complete"
} catch (error) {
  state.failureClass = error instanceof Error ? error.name : "Unknown"
  await fs.writeFile(path.join(root, "child-error-private.log"), error instanceof Error ? error.stack ?? error.message : String(error), { mode: 0o600 })
} finally {
  for (const id of state.sessions)
    await AppRuntime.runPromise(SessionExecution.Service.use((execution) => execution.interrupt(SessionSchema.ID.make(id)))).catch(() => undefined)
  await state.listener?.stop()
  await AppRuntime.dispose()
  await fs.writeFile(path.join(root, "child-window-result-private.json"), JSON.stringify(state, null, 2), { mode: 0o600 })
  originalPort.postMessage({ type: "client-window-stopped", succeeded: state.succeeded, stage: state.stage })
  // Only after the real listener/Root Scope finishes. This fixture's parent-port
  // lifetime is not the product app's shutdown protocol.
  process.exit(state.succeeded ? 0 : 1)
}
