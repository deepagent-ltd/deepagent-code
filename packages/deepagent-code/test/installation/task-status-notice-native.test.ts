import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
import { sql } from "drizzle-orm"
import { layer } from "@deepagent-code/core/database/sqlite.bun"
import { EffectDrizzleSqlite } from "../../../effect-drizzle-sqlite/src/index"
import { Hash } from "@deepagent-code/core/util/hash"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { MessageTable } from "@deepagent-code/core/im/sql"
import { EventInvestigationInstallation } from "./fixture/event-investigation-installation"
import { KernelLiveFirstSeenFixture } from "../im/fixture/kernel-live-first-seen"

const actual = process.platform === "darwin" && process.arch === "arm64" && process.env.DAC_TASK_NOTICE_ACTUAL === "1"
  ? test : test.skip
const assets = process.env.DAC_TASK_NOTICE_NATIVE_ASSETS ?? "/private/tmp/dac-v203-cli-command-runtime-c6Y1Cn/cli/deepagent-code-darwin-arm64/bin"
const marker = "NATIVE_KERNEL_WORK_APPROVED_GUARD"
const auditedText = "Read the explicitly approved guard.test.ts bytes, then report the original marker in this conversation."

actual("current signed Root reconciles lost accept response and delivers a separately authorized cancellation notice", async () => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-task-status-notice-native-"))
  await fs.writeFile("/tmp/dac-task-status-notice-native-current", root, { mode: 0o600 })
  const completed = { value: false }
  const child: { value?: ReturnType<EventInvestigationInstallation.NativeCase["spawn"]> } = {}
  const phase = { value: "private-peers" }
  const wire: { text: string; nativeID: string; requestHash: string }[] = []
  const requests: { path: string; authenticated: boolean; body: unknown }[] = []
  const generations = { value: 0, originalReadOutput: false }
  const current: { candidate?: EventInvestigationInstallation.NativeCase; mode: string; offline: boolean } = { mode: "", offline: false }
  const facts: unknown[] = []
  const native = KernelLiveFirstSeenFixture.make({
    fetch(request) {
      const pathname = new URL(request.url).pathname
      if (!pathname.startsWith("/api/im/")) return
      if (request.method !== "POST" || request.headers.get("authorization") !== "Bearer private-kernel-work-facade")
        return Response.json({ success: false }, { status: 403 })
      if (pathname === "/api/im/exchange") return Response.json({ success: true, data: {
        kernel_token: "private-first-seen-token", credential_expires_at: Date.now() + 3_600_000,
        navigator_url: native.server.url.origin, appkey: "private-native-kernel-work",
        identity: { uuid: "receiver", name: "Receiver", org_id: 1, org_all_group_id: "unused" },
        ttl: { msg_life_time_ms: 86_400_000 },
      } })
      if (pathname === "/api/im/conversations/inspect" && current.offline) return Response.json({ success: false }, { status: 503 })
      if (pathname === "/api/im/conversations/inspect") return Response.json({ success: true, data: {
        conversation_type: 1, conversation_id: "sender", org_id: 1, name: "Sender", member_uuids: ["receiver", "sender"],
      } })
      return Response.json({ success: false }, { status: 404 })
    },
    response(topic, request, original) {
      if (topic === "qry_delivery_capabilities") return { name: "DeliveryCapabilities", value: {
        version: 1, profile: "mysql-receipt-v1", maxLifetimeMs: 259200000, maxContentBytes: 65536, eventualDelivery: false,
      } }
      if (topic === "qry_delivery_read_cut") return { name: "DeliveryReadCutResult", value: {
        version: 1, scopeKey: request.scopeKey, projectionKey: request.projectionKey,
        projectionRevision: request.projectionRevision, throughOrdinal: "0", targetAdmittedOrdinal: String(native.messages.length),
        readOrdinal: "0", liveUnread: String(native.messages.length), storedUnread: String(native.messages.length),
        complete: native.messages.length === 0, serverNow: Date.now(),
      } }
      return original
    },
    outboundPublish(request, message) {
      assert.equal(request.targetId, "sender")
      assert.equal(message.msgType, "jg:text")
      assert.equal(message.deliveryVersion, 1)
      assert.ok(message.msgContent instanceof Uint8Array)
      const content = Schema.decodeUnknownSync(Schema.Struct({ content: Schema.String }))(
        Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(new TextDecoder().decode(message.msgContent)))
      const requestHash = Hash.sha256(JSON.stringify(["dac.delivery.request.v1", 1, request.targetId, message.clientUid,
        "jg:text", content.content, 10, Number(String(message.deliveryExpiresAt))])
        .replace(/[<>&\u2028\u2029]/g, (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0")))
      const nativeID = `actual-kernel-work-result-${wire.length + 1}`
      wire.push({ text: content.content, nativeID, requestHash })
      return { code: 0, msgId: nativeID, timestamp: Date.now(), msgIndex: wire.length + 1,
        clientMsgId: message.clientUid, deliveryVersion: 1, deliveryExpiresAt: Number(String(message.deliveryExpiresAt)),
        deliveryRequestHash: requestHash }
    },
  })
  const certificate = await EventInvestigationInstallation.certificate(root)
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0,
    tls: { key: Bun.file(certificate.keyPath), cert: Bun.file(certificate.certificatePath) },
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      const body: unknown = await request.json()
      requests.push({ path: pathname, body, authenticated: request.headers.get("authorization") === "Bearer fixture-native-key" })
      if (pathname === "/v1/responses/input_tokens") return Response.json({ object: "response.input_tokens", input_tokens: 41 })
      if (pathname !== "/v1/responses") return new Response("unavailable", { status: 404 })
      generations.value++
      if (generations.value === 1) {
        const call = { type: "function_call", id: "item_kernel_read", call_id: "call_kernel_read", name: "read",
          arguments: JSON.stringify({ path: "guard.test.ts", byteOffset: 0, pageBytes: 51200 }) }
        return new Response([
          { type: "response.output_item.added", item: { ...call, arguments: "" } },
          { type: "response.function_call_arguments.delta", item_id: call.id, delta: call.arguments },
          { type: "response.output_item.done", item: call },
          { type: "response.completed", response: { id: "response_kernel_read",
            usage: { input_tokens: 41, output_tokens: 12, total_tokens: 53 } } },
        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
      }
      const input = Schema.decodeUnknownSync(Schema.Struct({ input: Schema.Array(Schema.Unknown) }))(body).input
      generations.originalReadOutput = input.some((item) => typeof item === "object" && item !== null &&
        "type" in item && item.type === "function_call_output" && "call_id" in item && item.call_id === "call_kernel_read" &&
        "output" in item && typeof item.output === "string" && item.output.includes(marker))
      return new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "message_kernel_final",
        delta: `Verified original approved bytes: ${marker}.` })}\n\n` +
        `data: ${JSON.stringify({ type: "response.completed", response: { id: "response_kernel_final",
          usage: { input_tokens: 41, output_tokens: 12, total_tokens: 53 } } })}\n\n`,
        { headers: { "content-type": "text/event-stream" } })
    },
  })
  try {
    phase.value = "fixed-assets"
    expect(EventInvestigationInstallation.hash(await fs.readFile(path.join(assets, "deepagent-work-file-helper"))))
      .toBe("49bf2e21c0dd4fd63d7c98660a747711d2d88afbb03fa27343140733fde769eb")
    expect(EventInvestigationInstallation.hash(await fs.readFile(path.join(assets, "bun-command-runtime"))))
      .toBe("183032b4a7eb0ddeb366b270b2e561f84752487c019d101b4d891e9090acf93f")
    expect(EventInvestigationInstallation.hash(await fs.readFile(path.join(assets, "deepagent-work-storage-cleanup"))))
      .toBe("fa189f6391c28eed5d3a1174951c9cfade8efa48532c41a5d77d2ce11bc178ba")
    phase.value = "one-current-signed-candidate"
    const installation = await EventInvestigationInstallation.build({ directory: root, assets,
      storageCleanupAsset: path.join(assets, "deepagent-work-storage-cleanup"), ca: certificate.ca,
      origin: provider.url.origin, debugFixturePath: path.join(import.meta.dir, "fixture/task-status-notice.ts") })
    const mode = "cancel_notice"
    {
      native.messages.length = 0
      native.state.revision++
      wire.length = 0
      requests.length = 0
      generations.value = 0
      generations.originalReadOutput = false
      current.mode = mode
      current.offline = false
    const candidate = await EventInvestigationInstallation.caseFor({ installation, directory: path.join(root, mode),
      sourceText: `export const originalMarker = "${marker}";\n` })
    current.candidate = candidate
    const issuedAt = Date.now()
    await fs.writeFile(candidate.policy, JSON.stringify({ version: 2,
      kernelReceivers: [{ id: "original-kernel-receiver", targetID: "review", realmID: new URL(native.server.url.origin).href,
        appkeyID: "private-native-kernel-work", orgID: 1, receiverID: "receiver", localUserID: "server",
        issuedAt, expiresAt: issuedAt + 7 * 86_400_000 }],
      targets: [{ id: "review", directory: candidate.project, agentID: "auto", providerID: "openai",
        modelID: "gpt-4.1-2025-04-14", budget: { ...WorkAuthorityPolicy.PROJECT_PROFILE.budget,
          maxChildren: 0, maxDurationMs: 120000, maxProviderDispatches: 2, maxToolCalls: 1 },
        project: { tools: ["read"], fileScope: { read: [{ kind: "file", path: "guard.test.ts" }], write: [], deny: [],
          maxReadBytes: 65536, maxPageBytes: 51200, maxHashBytes: 16777216, maxWriteBytes: 0, symlinks: "deny" } } }],
    }), { mode: 0o600 })
    phase.value = "formal-cli-enroll-and-route"
    const enrolled = await candidate.run("enroll", ["operator", "enroll", "--request-id", "kernel-work-enroll", "--policy", candidate.policy])
    expect(enrolled.code, enrolled.stderr.slice(-1800)).toBe(0)
    const approved = await candidate.run("approve", ["operator", "approve-route", "--request-id", "kernel-work-route",
      "--target", "review", "--snapshot", "gpt-4.1-2025-04-14", "--expected-revision", "1",
      "--expected-route-revision", "0", "--expires-at", String(Date.now() + 3_600_000)])
    expect(approved.code, approved.stderr.slice(-1800)).toBe(0)
    const extra = { DAC_NOTICE_RESULT: path.join(candidate.directory, "result.json"),
      DAC_NOTICE_READY: path.join(candidate.directory, "reader-ready"), DAC_NOTICE_CA: certificate.certificatePath,
      DAC_NOTICE_KEY: certificate.keyPath, DEEPAGENT_IM_FACADE_URL: native.server.url.origin,
      DEEPAGENT_IM_FACADE_KEY: "private-kernel-work-facade" }
    await fs.writeFile(path.join(candidate.directory, "exact-private-env.json"), JSON.stringify({ ...candidate.env, ...extra }), { mode: 0o600 })
    phase.value = "current-root-and-new-live-source"
    child.value = candidate.spawn(["debug"], extra)
    const output = new Response(child.value.stdout).text()
    const errors = new Response(child.value.stderr).text()
    const stopped = child.value.exited.then((code) => ({ code }))
    const deadline = Date.now() + 70000
    while (!(await Bun.file(extra.DAC_NOTICE_READY).exists())) {
      if (child.value.exitCode !== null || Date.now() >= deadline) break
      await Bun.sleep(20)
    }
    if (await Bun.file(extra.DAC_NOTICE_READY).exists()) {
      // The message is invisible during original initial sync. Commit and original WS
      // publication happen in this one JS turn; no history row is upgraded afterward.
      const source = native.add("actual-kernel-work-source", { publish: false })
      source.content = JSON.stringify({ content: auditedText })
      native.publish(source)
    }
    phase.value = "actual-execution-and-result"
    const [exit, stdout, stderr] = await Promise.all([stopped, output, errors])
    await fs.writeFile(path.join(candidate.directory, "actual.log"), stdout + stderr, { mode: 0o600 })
    await fs.writeFile(path.join(root, "transport-facts.json"), JSON.stringify({ requests, wire, generations,
      topics: native.topics, disconnected: native.state.disconnected }), { mode: 0o600 })
    expect(exit.code, stderr.slice(-2400)).toBe(0)
    const result = await Bun.file(extra.DAC_NOTICE_RESULT).json()
    expect(result.stage).toBe("complete")
    expect(result.error).toBeUndefined()
    expect(result.before.source).toHaveLength(0)
    expect(result.before.sessions).toHaveLength(0)
    expect(result.before.inputs).toHaveLength(0)
    expect(result.after.source).toHaveLength(1)
    expect(result.after.requests).toHaveLength(1)
    expect(result.after.grants).toHaveLength(1)
    expect(result.after.work).toEqual([expect.objectContaining({ admission_state: "ready", control_state: "cancelled", outcome: "succeeded" })])
    expect(result.after.sessions).toHaveLength(1)
    expect(result.after.sessions[0].execution_claim_token).toBeNull()
    expect(result.after.inputs).toEqual([expect.objectContaining({ delivery: "queue" })])
    expect(result.after.inputs[0].promoted_seq).not.toBeNull()
    expect(result.after.tools).toEqual([{ state: "settled", effect_kind: "read_only", known_read: 1 }])
    expect(result.after.providers.map((row: { state: string }) => row.state)).toEqual(["settled", "settled"])
    expect(result.after.receipts.map((row: { state: string }) => row.state)).toEqual(["settled", "settled"])
    expect(result.after.counts.map((row: { state: string }) => row.state)).toEqual(["settled", "settled"])
    const observedCounts = result.after.counts.map((row: { record: string }) => Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ result: Schema.Struct({ inputTokens: Schema.Number }) })))(row.record).result.inputTokens)
    const usage = result.after.receipts.map((row: { outcome_artifact: string }) => Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Array(Schema.Struct({ usage: Schema.optional(Schema.Struct({
        inputTokens: Schema.Number, outputTokens: Schema.Number, totalTokens: Schema.Number,
      })) }))))(row.outcome_artifact).flatMap((event) => event.usage ? [event.usage] : []).at(-1))
    expect(observedCounts).toEqual([41, 41])
    expect(usage).toEqual([{ inputTokens: 41, outputTokens: 12, totalTokens: 53 }, { inputTokens: 41, outputTokens: 12, totalTokens: 53 }])
    expect(result.after.dispatches.map((row: { state: string; charged_tokens: number }, index: number) => ({
      state: row.state, charged: row.charged_tokens, actualUsage: usage[index].totalTokens,
    }))).toEqual([{ state: "settled", charged: 53, actualUsage: 53 }, { state: "settled", charged: 53, actualUsage: 53 }])
    expect(result.acceptResponseLoss).toEqual({ status: 200, bodyBytes: 0 })
    expect(result.exactAcceptZeroIncrement).toBe(true)
    expect(result.notice.kind).toBe("cancel_requested")
    expect(result.notice.text).not.toContain(marker)
    expect(result.noticeDelivery.state).toBe("acknowledged")
    expect(result.locator).toMatchObject({ state: "available", notice: { kind: "cancel_requested" },
      task: { grant: { state: "revoked" }, work: { outcome: "succeeded", controlState: "cancelled", hasExecutionClaim: false } } })
    expect(result.remoteStatus.located).toEqual(result.locator)
    expect(result.remoteStatus.tuple).toMatchObject({ version: 1, kernelMessageID: result.noticeDelivery.nativeID,
      senderID: "receiver", receiverID: "sender", conversationType: 1, conversationID: "receiver" })
    expect(result.remoteStatus.substituted).toEqual({ version: 1, state: "unavailable", code: "remote_status_unlinked" })
    expect(result.remoteStatus.exact).toBe(true)
    expect(result.remoteStatus.readonly).toBe(true)
    expect(result.remoteStatus.protectedTables).toEqual(["im_task_status_notice", "im_reply_outbox", "im_kernel_delivery"])
    expect(requests.filter((row) => row.path === "/v1/responses/input_tokens")).toHaveLength(2)
    expect(requests.filter((row) => row.path === "/v1/responses")).toHaveLength(2)
    expect(requests.every((row) => row.authenticated)).toBe(true)
    expect(generations.originalReadOutput).toBe(true)
    expect(wire).toHaveLength(2)
    expect(wire[0]?.text).toContain(marker)
    expect(wire[1]?.text).toBe((await noticeWire(candidate.dbPath, result.notice.deliveryMessageID)).content)
    facts.push({ mode, result, physicalCounts: 2, physicalProviders: 2, physicalPUB: wire.length })
    await fs.writeFile(path.join(root, "fault-facts.json"), JSON.stringify(facts), { mode: 0o600 })
    child.value.kill()
    await child.value.exited
    child.value = undefined
    }
    completed.value = true
  } finally {
    child.value?.kill()
    if (child.value) await child.value.exited
    await provider.stop(true)
    await native.server.stop(true)
    await fs.writeFile(path.join(root, "cleanup.json"), JSON.stringify({ phase: phase.value, completed: completed.value,
      ownChildEnded: !child.value || child.value.exitCode !== null, peerClosed: true, providerClosed: true }), { mode: 0o600 })
    if (!completed.value) process.stderr.write(`KERNEL_WORK_PRIVATE_FAILURE ${phase.value} ${root}\n`)
  }
}, 240_000)

function noticeWire(dbPath: string, messageID: string) {
  return Effect.runPromise(Effect.gen(function* () {
    const db = yield* EffectDrizzleSqlite.makeWithDefaults()
    const receipt = yield* KernelDelivery.read(db, messageID)
    const message = yield* db.select().from(MessageTable).where(sql`${MessageTable.id}=${messageID}`).get()
    assert(receipt && message)
    assert.equal(receipt.state, "acknowledged")
    const wire = KernelDelivery.wireMessage(receipt.binding, message)
    assert(wire)
    assert.equal(wire.messageType, "jg:text")
    return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ content: Schema.String })))(wire.content)
  }).pipe(Effect.provide(layer({ filename: dbPath, readonly: true })), Effect.scoped))
}

const replay = process.env.DAC_TASK_NOTICE_ORACLE_REPLAY ? test : test.skip
replay("saved actual transport oracle replay uses original wireMessage; no new build, Root or requests", async () => {
  const root = await fs.realpath(process.env.DAC_TASK_NOTICE_ORACLE_REPLAY!)
  const result = await Bun.file(path.join(root, "cancel_notice/result.json")).json()
  const transport = await Bun.file(path.join(root, "transport-facts.json")).json()
  expect(result.stage).toBe("complete")
  expect(result.error).toBeUndefined()
  expect(result.acceptResponseLoss).toEqual({ status: 200, bodyBytes: 0 })
  expect(result.exactAcceptZeroIncrement).toBe(true)
  expect(result.after.work).toEqual([expect.objectContaining({ admission_state: "ready", control_state: "cancelled", outcome: "succeeded" })])
  expect(result.after.inputs).toHaveLength(1)
  expect(result.after.sessions).toEqual([expect.objectContaining({ execution_claim_token: null })])
  expect(result.after.tools).toEqual([{ state: "settled", effect_kind: "read_only", known_read: 1 }])
  expect(result.after.dispatches).toEqual([{ state: "settled", charged_tokens: 53 }, { state: "settled", charged_tokens: 53 }])
  expect(result.noticeDelivery).toMatchObject({ state: "acknowledged", nativeID: "actual-kernel-work-result-2" })
  expect(result.locator).toMatchObject({ state: "available", notice: { kind: "cancel_requested" },
    task: { grant: { state: "revoked" }, work: { outcome: "succeeded", controlState: "cancelled", hasExecutionClaim: false } } })
  expect(transport.requests.filter((entry: { path: string }) => entry.path === "/v1/responses/input_tokens")).toHaveLength(2)
  expect(transport.requests.filter((entry: { path: string }) => entry.path === "/v1/responses")).toHaveLength(2)
  expect(transport.wire).toHaveLength(2)
  expect(transport.wire[1].text).toBe((await noticeWire(path.join(root, "cancel_notice/database.sqlite"), result.notice.deliveryMessageID)).content)
  expect((await Bun.file(path.join(root, "source-cohort.json")).json()).drift).toEqual([])
  expect(await Bun.file(path.join(root, "cleanup.json")).json()).toMatchObject({ ownChildEnded: true, peerClosed: true, providerClosed: true })
})
