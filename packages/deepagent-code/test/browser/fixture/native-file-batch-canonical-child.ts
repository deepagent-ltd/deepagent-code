// Only the original Root and Session runner create admissions, tool effects and permissions.
import { Server, BrowserNativeHost } from "../../../src/node"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
import { sql } from "drizzle-orm"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { Database } from "@deepagent-code/core/database/database"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { BrowserFileSchema } from "@deepagent-code/core/browser/file-exchange.schema"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { NativeInstallation } from "../../../src/installation/native-installation"
import { LocalTaskAuthority } from "../../../src/im/local-task-authority"

const root = process.env.DAC_BROWSER_TEST_ROOT!
const directory = path.join(root, "project")
const origin = process.env.DAC_BROWSER_ORIGIN!
const port = Reflect.get(process, "parentPort") as {
  postMessage(value: unknown): void
  on(event: "message", listener: (event: { data: unknown; ports: Array<{
    on(event: "message", listener: (event: { data: unknown }) => void): void
  }> }) => void): void
}
// Passive metadata from the original transferred port locates a failed transfer.
// This listener cannot approve a leaf, return bytes, or replace the original host.
const transport = { firstLeafAt: 0, lastLeafAt: 0, checks: 0,
  leaves: new Map<string, { ordinal: number; reads: number; requestedBytes: number; lastOffset: number;
    seals: number; observations: number; writes: number; publications: number }>() }
const uiReady = new Map(["upload", "download"].map((direction) => [direction, Promise.withResolvers<void>()]))
port.on("message", (event) => {
  if (event.data && typeof event.data === "object" && Reflect.get(event.data, "type") === "canonical-file-ui-ready") {
    const direction = Reflect.get(event.data, "direction")
    if (typeof direction === "string") uiReady.get(direction)?.resolve()
    return
  }
  if (event.ports.length !== 1) return
  event.ports[0]!.on("message", (message) => {
    if (!message.data || typeof message.data !== "object") return
    const type = Reflect.get(message.data, "type")
    if (type === "check") { transport.checks++; return }
    if (type !== "file.leaf") return
    const artifactID = Reflect.get(message.data, "artifactID")
    const operation = Reflect.get(message.data, "operation")
    if (typeof artifactID !== "string" || typeof operation !== "string") return
    const leaf = transport.leaves.get(artifactID) ?? { ordinal: transport.leaves.size, reads: 0,
      requestedBytes: 0, lastOffset: 0, seals: 0, observations: 0, writes: 0, publications: 0 }
    transport.leaves.set(artifactID, leaf)
    transport.firstLeafAt ||= Date.now()
    transport.lastLeafAt = Date.now()
    if (operation === "upload.read") {
      leaf.reads++
      leaf.requestedBytes += Number(Reflect.get(message.data, "length"))
      leaf.lastOffset = Number(Reflect.get(message.data, "offset"))
    }
    if (operation === "upload.seal") leaf.seals++
    if (operation === "upload.observe") leaf.observations++
    if (operation === "download.write") leaf.writes++
    if (operation === "download.publish") leaf.publications++
  })
})
await BrowserNativeHost.prepare()
const state: { listener?: Awaited<ReturnType<typeof Server.listen>>; stage: string; error?: string } = { stage: "root" }
const permissions: Array<{ sessionID: string; action: string }> = []
const controls: Array<typeof BrowserSchema.ControlView.Type> = []
const previewSchema = Schema.Struct({ controlID: BrowserSchema.ID, previewID: BrowserFileSchema.ID,
  controlRevision: BrowserSchema.Revision, preview: Schema.Unknown })
const approvedSchema = Schema.Struct({ controlID: BrowserSchema.ID, grant: BrowserFileSchema.GrantSummary, replayed: Schema.Boolean })
const permissionList = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: PermissionV2.ID,
  sessionID: SessionSchema.ID, action: Schema.String, resources: Schema.Array(Schema.String), source: PermissionV2.Source })) })
const census = () => AppRuntime.runPromise(Effect.gen(function* () {
  const db = (yield* Database.Service).db
  return {
    actions: (yield* db.all<{ record: string }>("SELECT record FROM browser_action ORDER BY created_at,action_id"))
      .map((row) => Schema.decodeUnknownSync(Schema.fromJsonString(BrowserSchema.Action))(row.record)),
    providers: yield* db.all("SELECT attempt_id,session_id,state FROM session_provider_attempt ORDER BY created_at,attempt_id"),
    admissions: yield* db.all("SELECT admission_id,receipt_id,provider_attempt_id,session_id,tool_call_id,tool_name FROM session_v2_tool_effect_admission ORDER BY time_created,admission_id"),
    effects: yield* db.all("SELECT receipt_id,tool_call_id,state,effect_kind FROM session_v2_tool_effect ORDER BY time_created,effect_id"),
    inputs: yield* db.all("SELECT id,session_id,delivery,promoted_seq FROM session_input"),
    work: yield* db.all("SELECT work_id FROM work_execution"), counts: yield* db.all("SELECT acquisition_id FROM work_count_acquisition"),
    saved: yield* db.all("SELECT * FROM permission"),
    files: yield* db.all<{ record: string }>("SELECT record FROM browser_file_artifact ORDER BY created_at,artifact_id"),
    capacity: yield* db.all("SELECT * FROM browser_file_capacity"),
  }
}))
async function request(route: string, body?: unknown) {
  assert(state.listener)
  const response = await fetch(new URL(route, state.listener.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Basic ${Buffer.from("deepagent-code:private-fixture").toString("base64")}`,
      "content-type": "application/json", "x-deepagent-code-directory": directory, connection: "close" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90_000) })
  if (response.status === 204) return undefined
  const value: unknown = await response.json()
  assert.equal(response.status, 200, `${route}: ${JSON.stringify(value)}`)
  return value
}
try {
  await AppRuntime.runPromise(Database.Service)
  // Explicit private installation setup uses the existing offline entrypoint. No
  // GET/preview/dispatch is allowed to silently mint an instance or operator.
  state.stage = "private-installed-setup"
  await AppRuntime.runPromise(Effect.gen(function* () {
    yield* NativeInstallation.current()
    yield* LocalTaskAuthority.initializeInstallation()
  }))
  state.listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  for (const direction of (process.env.DAC_BROWSER_FILE_BATCH_DIRECTION === "download" ? ["download"] : ["upload", "download"]) as ReadonlyArray<"upload" | "download">) {
    state.stage = `${direction}-create`
    const session = await AppRuntime.runPromise(SessionV2.Service.use((sessions) => sessions.create({
      location: { directory: AbsolutePath.make(directory) },
      model: { providerID: ProviderV2.ID.make("fixture"), id: ModelV2.ID.make("test-model") },
      permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "browser", resource: "*", effect: "ask" },
        { action: "browser-file", resource: "*", effect: "ask" }],
    })))
    const created = Schema.decodeUnknownSync(BrowserSchema.ControlView)(await request("/api/v1/browser/controls", {
      requestID: `canonical-files-${direction}`, sessionID: session.id, profile: BrowserSchema.FILE_EXCHANGE_PROFILE,
      origin, postPaths: ["/upload"], filePolicy: { upload: direction === "upload", download: direction === "download" },
      expiresAt: Date.now() + 180_000,
    }))
    assert.equal(created.nativeVerification, "verified")
    const grants: BrowserFileSchema.GrantSummary[] = []
    const relatives = direction === "upload" ? [0, 1, 2, 3].map((ordinal) => `source-${ordinal}.bin`) : ["download.bin"]
    for (const [ordinal, relative] of relatives.entries()) {
      state.stage = `${direction}-preview-${ordinal}`
      const preview = Schema.decodeUnknownSync(previewSchema)(await request(`/api/v1/browser/controls/${created.control.controlID}/files/preview`,
        direction === "upload" ? { direction, relative, targetPath: "/upload" }
          : { direction, relative, targetURL: origin + "/download", maxBytes: BrowserFileSchema.MAX_FILE_BYTES }))
      port.postMessage({ type: "canonical-file-native-pending", direction, ordinal })
      const approved = Schema.decodeUnknownSync(approvedSchema)(await request(`/api/v1/browser/controls/${created.control.controlID}/files/approve`, {
        requestID: `canonical-${direction}-grant-${ordinal}`, previewID: preview.previewID,
        expectedControlRevision: preview.controlRevision, expiresAt: Math.min(created.control.expiresAt, Date.now() + 120_000),
      }))
      assert.equal(approved.grant.state, "approved")
      grants.push(approved.grant)
    }
    port.postMessage({ type: "canonical-file-control", controlID: created.control.controlID, direction,
      grantIDs: grants.map((grant) => grant.grantID) })
    // Upload QA coordinates four separate native windows before observing the
    // page. The single download needs no extra UI marker: its original approve
    // request above already waits for the real native confirmation to finish.
    if (direction === "upload") {
      state.stage = `${direction}-ui-ready`
      await Promise.race([uiReady.get(direction)!.promise, new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Native UI completion barrier timed out")), 30_000)
        timer.unref()
      })])
    }
    state.stage = `${direction}-prompt`
    await request(`/api/session/${session.id}/prompt`, { id: `msg_file_canonical_${direction}`,
      prompt: { text: `Use only approved ${direction} grants in this connected browser; never repeat an unknown effect.` } })
    const replied = new Set<string>()
    const deadline = Date.now() + 75_000
    for (;;) {
      assert(Date.now() < deadline, `Original runner timed out at ${state.stage}`)
      const pending = Schema.decodeUnknownSync(permissionList)(await request(`/api/session/${session.id}/permission`))
      for (const item of pending.data) {
        if (replied.has(item.id)) continue
        assert(["browser", "browser-file"].includes(item.action))
        assert.equal(item.source?.type, "tool")
        assert.equal(item.sessionID, session.id)
        assert(item.resources.every((resource) => resource.startsWith(created.control.controlID + "/")))
        if (item.action === "browser-file") {
          const before = await census()
          assert.equal(before.actions.filter((action) => action.controlID === created.control.controlID && action.command.type === `file.${direction}`).length, 0)
          port.postMessage({ type: "canonical-file-permission-pending", direction })
        }
        replied.add(item.id)
        permissions.push({ sessionID: session.id, action: item.action })
        await request(`/api/session/${session.id}/permission/${item.id}/reply`, { reply: "once" })
      }
      const activity = await AppRuntime.runPromise(Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const failed = yield* db.get<{ state: string; error_code: string }>("SELECT state,error_code FROM session_provider_attempt WHERE state IN ('failed','indeterminate_after_crash') LIMIT 1")
        assert(!failed, `Original provider stopped: ${JSON.stringify(failed)}`)
        const terminal = yield* db.get<{ outcome: string; error_code: string }>(sql`SELECT outcome,json_extract(record,'$.errorCode') AS error_code FROM browser_action WHERE control_id = ${created.control.controlID} AND outcome IN ('unknown','failed','cancelled') LIMIT 1`)
        assert(!terminal, `Original browser action stopped: ${JSON.stringify(terminal)}`)
        return yield* db.get<{ state: string }>(sql`SELECT state FROM session_activity WHERE session_id = ${session.id} ORDER BY created_at DESC LIMIT 1`)
      }))
      if (activity?.state === "settled") break
      assert(!activity || !["failed", "interrupted"].includes(activity.state))
      await new Promise<void>((resolve) => setTimeout(resolve, 30))
    }
    await AppRuntime.runPromise(SessionExecution.Service.use((execution) => execution.awaitIdle(SessionSchema.ID.make(session.id))))
    const facts = await census()
    const files = facts.actions.filter((action) => action.controlID === created.control.controlID && action.command.type === `file.${direction}`)
    assert.equal(files.length, 1)
    assert.equal(files[0]!.outcome, "completed", JSON.stringify(files[0]))
    assert.equal(files[0]!.result?.files?.length, grants.length)
    const current = Schema.decodeUnknownSync(BrowserSchema.ControlView)(await request(`/api/v1/browser/controls/${created.control.controlID}`))
    const stopped = Schema.decodeUnknownSync(BrowserSchema.ControlView)(await request(`/api/v1/browser/controls/${created.control.controlID}/cancel`, {
      requestID: `canonical-close-${direction}`, expectedRevision: current.control.revision,
    }))
    assert.equal(stopped.stopConfirmed, true)
    controls.push(stopped)
  }
  assert.deepEqual(await fs.readFile(path.join(directory, "download.bin")), await fs.readFile(path.join(directory, "source-0.bin")))
  state.stage = "complete"
} catch (error) {
  state.error = error instanceof Error ? error.stack : String(error)
} finally {
  const facts = await census().catch((error) => ({ error: String(error) }))
  await state.listener?.stop()
  await AppRuntime.dispose()
  await fs.writeFile(path.join(root, "child-result.json"), JSON.stringify({ stage: state.stage, error: state.error,
    permissions, controls, facts, transport: { firstLeafAt: transport.firstLeafAt, lastLeafAt: transport.lastLeafAt,
      checks: transport.checks, leaves: [...transport.leaves.values()] } }, null, 2), { mode: 0o600 })
  port.postMessage({ type: "canonical-file-result", succeeded: state.stage === "complete" })
}
