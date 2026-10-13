import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { IMTaskStatusNoticeSchema } from "@deepagent-code/core/im/task-status-notice.schema"
import { IMTaskStatusNotice } from "@deepagent-code/core/im/task-status-notice"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { command } from "@/cli/cmd/operator"
import { AppRuntime } from "@/effect/app-runtime"
import { Server } from "@/server/server"
import { ServerAuth } from "@/server/auth"
import { KernelTaskSource } from "@/im/kernel/task-source"
import { IMTaskStatusNoticeHost } from "@/im/task-status-notice"

const root = process.argv[2]!
const directory = path.join(root, "project")
await Bun.write(path.join(directory, "deepagent-code.json"), JSON.stringify({ formatter: false, lsp: false,
  model: "fixture/test-model", providers: { fixture: { api: { type: "native", url: "https://example.invalid/v1/chat/completions",
    protocol: "openai-compatible.chat", settings: {} }, models: { "test-model": { api: { id: "test-model" } } } } } }))
const policy = path.join(root, "policy.json")
await Bun.write(policy, JSON.stringify({ version: 1, targets: [{ id: "review", directory, agentID: "auto", providerID: "fixture",
  modelID: "test-model", budget: { ...WorkAuthorityPolicy.TEXT_ONLY_PROFILE.budget, maxTotalTokens: 8000 } }] }))
const database = Database.defaultLayer
await Effect.runPromise(command({ action: "enroll", operationID: "status-enroll", policyPath: policy }).pipe(
  Effect.provide(LocationIdentity.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer))),
  Effect.provide(database), Effect.provide(ServerAuth.Config.defaultLayer), Effect.scoped))
const rg = Bun.which("rg")
assert(rg)
const bin = path.join(root, "home/.deepagent/code/cache/bin")
await fs.mkdir(bin, { recursive: true })
await fs.copyFile(rg, path.join(bin, "rg"))
await AppRuntime.runPromise(Database.Service)
const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
const headers = { authorization: ServerAuth.header({ username: "status-operator", password: "private-status-password" })!,
  "x-deepagent-code-directory": encodeURIComponent(directory), "content-type": "application/json" }
const requests: { route: string; status: number }[] = []
const request = async (route: string, body?: unknown, overrides?: Record<string, string>) => {
  console.info("STATUS_HTTP_REQUEST", route, body === undefined ? "read" : "mutation")
  const response = await fetch(new URL(route, listener.url), { method: body === undefined ? "GET" : "POST",
    headers: { ...headers, ...overrides }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) })
  requests.push({ route, status: response.status })
  console.info("STATUS_HTTP_RESPONSE", route, response.status)
  return { status: response.status, value: await response.json() }
}
const census = () => AppRuntime.runPromise(Effect.gen(function* () {
  const db = (yield* Database.Service).db
  return yield* db.get("SELECT (SELECT count(*) FROM session) sessions,(SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM work_execution) work,(SELECT count(*) FROM session_provider_attempt) providers,(SELECT count(*) FROM work_count_acquisition) counts,(SELECT count(*) FROM work_dispatch_reservation) dispatches,(SELECT count(*) FROM im_task_grant) grants")
}))
try {
  const group = await request("/api/v1/im/groups", { type: "project", name: "status management" })
  assert.equal(group.status, 200)
  assert.equal((await request(`/api/v1/im/tasks/conversations/${group.value.id}`, { operationID: "status-mode", targetID: "review", expectedRevision: 0 })).status, 200)
  const source = await request(`/api/v1/im/groups/${group.value.id}/messages`, { senderType: "user", type: "text",
    content: "Please explicitly review this request.", clientRequestID: "status-source" })
  assert.equal(source.status, 200)
  const proposed = await request("/api/v1/im/tasks/requests", { clientRequestID: "status-propose", messageID: source.value.id, auditedText: source.value.content })
  assert.equal(proposed.status, 200)
  const route = `/api/v1/im/tasks/requests/${proposed.value.id}`
  const command = { operationID: "refuse-original", expectedRevision: proposed.value.revision }
  const before = await census()
  assert.deepEqual(before, { sessions: 0, inputs: 0, work: 0, providers: 0, counts: 0, dispatches: 0, grants: 0 })
  assert.equal((await request(route + "/refuse", command, { authorization: "" })).status, 401)
  assert.equal((await request(route + "/refuse", command, { "x-deepagent-code-directory": encodeURIComponent(path.join(root, "other")) })).status, 403)
  const refused = await request(route + "/refuse", command)
  assert.equal(refused.status, 200, JSON.stringify(refused.value))
  const receipt = Schema.decodeUnknownSync(IMTaskStatusNoticeSchema.RefuseReceipt)(refused.value.receipt ?? refused.value)
  assert.equal(receipt.state, "refused")
  const exact = await request(route + "/refuse", command)
  assert.equal(exact.status, 200)
  assert.deepEqual(Schema.decodeUnknownSync(IMTaskStatusNoticeSchema.RefuseReceipt)(exact.value.receipt ?? exact.value), receipt)
  assert.equal((await request(route + "/refuse", { ...command, operationID: "conflicting-refuse" })).status, 409)
  assert.equal((await request(route + "/accept", { operationID: "accept-refused", expectedRevision: proposed.value.revision })).status, 409)
  const observed = await request(route)
  assert.equal(observed.status, 200)
  assert.equal(observed.value.state, "proposed")
  assert.equal(observed.value.disposition, "refused")
  const hashes = () => AppRuntime.runPromise(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    return (yield* db.all<Record<string, unknown>>("SELECT * FROM im_task_status_notice")).map((row) => Hash.sha256(CanonicalJson.stringify(row)))
  }))
  const original = await hashes()
  assert.equal(original.length, 1)
  assert.equal((await request(route + "/state")).status, 200)
  assert.equal((await request(route)).status, 200)
  assert.deepEqual(await hashes(), original)
  const purposeChecks = await AppRuntime.runPromise(Effect.gen(function* () {
    console.info("STATUS_PURPOSE", "start")
    const existing = yield* Database.Service
    const originalFactory = yield* Effect.scoped(Effect.gen(function* () {
      const source = yield* KernelTaskSource.make.pipe(Effect.provideService(Database.Service, existing))
      const notices = yield* IMTaskStatusNoticeHost.make.pipe(Effect.provideService(Database.Service, existing),
        Effect.provideService(KernelTaskSource.Service, source))
      const handle = yield* notices.prepare(receipt.noticeID)
      console.info("STATUS_PURPOSE", "prepared")
      assert.equal((yield* existing.db.transaction((tx) => notices.verify(tx, { noticeID: receipt.noticeID, original: handle }))).noticeID, receipt.noticeID)
      assert.equal((yield* existing.db.transaction((tx) => notices.verify(tx, { noticeID: receipt.noticeID, original: { ...handle } })).pipe(Effect.exit))._tag, "Failure")
      const foreign = yield* IMTaskStatusNoticeHost.make.pipe(Effect.provideService(Database.Service, existing),
        Effect.provideService(KernelTaskSource.Service, source))
      assert.equal((yield* existing.db.transaction((tx) => foreign.verify(tx, { noticeID: receipt.noticeID, original: handle })).pipe(Effect.exit))._tag, "Failure")
      const notice = yield* notices.read(receipt.noticeID)
      assert(notice)
      const repo = Context.get(yield* Layer.build(IMRepositoryLive.pipe(Layer.provide(Layer.succeed(Database.Service, existing)))), IMRepository)
      const message = yield* IMTaskStatusNotice.withCreation(existing.db, notice.noticeID, handle,
        repo.createMessage({ id: notice.deliveryMessageID, groupID: notice.groupID, senderID: notice.agentID,
          senderType: "agent", type: "text", content: notice.text,
          metadata: { type: "task_status_notice", noticeID: notice.noticeID, requestID: notice.requestID, kind: notice.kind } }))
        .pipe(Effect.provideService(IMTaskStatusNotice.CreationAuthority, notices))
      assert.equal(message.content, notice.text)
      return { notices, handle, messageID: message.id }
    }))
    console.info("STATUS_PURPOSE", "scope-disposed")
    assert.equal((yield* existing.db.transaction((tx) => originalFactory.notices.verify(tx, { noticeID: receipt.noticeID, original: originalFactory.handle })).pipe(Effect.exit))._tag, "Failure")
    return { localCurrentAccepted: true, copyDenied: true, foreignFactoryDenied: true, disposedDenied: true,
      messageID: originalFactory.messageID,
      scope: "real local-origin purpose adapter; standalone factory checks, no Native capture" }
  }))
  const located = await request(`/api/v1/im/messages/${purposeChecks.messageID}/task-status`)
  assert.equal(located.status, 200, JSON.stringify(located.value))
  assert.equal(located.value.state, "available", JSON.stringify(located.value))
  assert.equal(located.value.notice.kind, "refused")
  assert.equal(located.value.task.requestID, proposed.value.id)
  assert.equal(located.value.task.disposition, "refused")
  assert.equal(located.value.task.work, null)
  assert.deepEqual((await request(`/api/v1/im/messages/${purposeChecks.messageID}/task-status`)).value, located.value)
  const remoteTuple = { version: 1, realm: "http://127.0.0.1:9/", appkey: "unlinked-status",
    orgID: "1", kernelMessageID: "missing-original-ack", senderID: "sender", receiverID: "receiver",
    conversationType: 1, conversationID: "sender" }
  assert.equal((await request("/api/v1/im/tasks/remote-status", { tuple: remoteTuple }, { authorization: "" })).status, 401)
  assert.equal((await request("/api/v1/im/tasks/remote-status", { tuple: remoteTuple }, { origin: "https://foreign.invalid" })).status, 503)
  const remoteStatus = await request("/api/v1/im/tasks/remote-status", { tuple: remoteTuple })
  assert.equal(remoteStatus.status, 200, JSON.stringify(remoteStatus.value))
  assert.deepEqual(remoteStatus.value, { version: 1, state: "unavailable", code: "remote_status_unlinked" })
  assert.deepEqual((await request("/api/v1/im/tasks/remote-status", { tuple: remoteTuple })).value, remoteStatus.value)
  assert.deepEqual(await hashes(), original)
  assert.deepEqual(await census(), before)
  await fs.writeFile(path.join(root, "result.json"), JSON.stringify({ receipt, requests, noExecution: await census(),
    noticeCount: original.length, readHashUnchanged: true, purposeChecks, locator: located.value,
    remoteStatus: remoteStatus.value,
    scope: "real Server Root HTTP/enrollment/local-origin/refusal and unlinked remote status; no Native execution" }), { mode: 0o600 })
} finally {
  console.info("STATUS_HTTP", "stopping")
  await listener.stop(true)
  await AppRuntime.dispose()
  console.info("STATUS_HTTP", "stopped")
}
process.exit(0)
