// Signed diagnostic caller only: one original Server Root, actual current kernel Source,
// formal HTTP admission, canonical runner, fixed Native assets and original SDK PUB/ACK.
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { request } from "node:https"
import { Cause, Effect, Exit, Schema } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { IMTaskStatusNotice } from "@deepagent-code/core/im/task-status-notice"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { AppRuntime } from "@/effect/app-runtime"
import { Server } from "@/server/server"
import { ServerAuth } from "@/server/auth"
import { LocalTaskAuthority } from "@/im/local-task-authority"
import { cmd } from "@/cli/cmd/cmd"
import { GroupPageResponse, IMStatusResponse } from "@/server/routes/instance/httpapi/groups/im"
import { RequestView, TaskState } from "@/im/task-history.schema"
import { IMTaskStatusLocator } from "@/im/task-status-locator"
import { IMRemoteTaskResult } from "@/im/remote-task-result"
import { IMRemoteTaskStatus } from "@/im/remote-task-status"

export const DebugCommand = cmd({ command: "debug", handler: async () => {
  const output = process.env.DAC_NOTICE_RESULT
  const ready = process.env.DAC_NOTICE_READY
  const caPath = process.env.DAC_NOTICE_CA
  const keyPath = process.env.DAC_NOTICE_KEY
  if (!output || !ready || !caPath || !keyPath) throw new Error("Private notice paths are required")
  const ca = await fs.readFile(caPath, "utf8")
  const key = await fs.readFile(keyPath, "utf8")
  const progress: Record<string, unknown> = { stage: "root", scope: "actual signed current Native status notice and HTTP response loss" }
  const outcome = await AppRuntime.runPromise(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const auth = yield* ServerAuth.Config
    const configured = yield* LocalTaskAuthority.configured(auth)
    yield* LocalTaskAuthority.authenticatePassword(db, configured.runtime, auth.username, configured.password)
    const listener = yield* Effect.acquireRelease(Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0,
      tls: { key, cert: ca } })), (listener) => Effect.promise(() => listener.stop(true)))
    const headers = { "content-type": "application/json", connection: "close", authorization: ServerAuth.header({ username: auth.username,
      password: configured.password })!, "x-deepagent-code-directory": process.cwd() }
    const http = (route: string, body?: unknown) => Effect.tryPromise({ try: async () => {
      const response = await fetch(new URL(route, listener.url), { method: body === undefined ? "GET" : "POST", headers,
        body: body === undefined ? undefined : JSON.stringify(body), tls: { rejectUnauthorized: true, ca },
        signal: AbortSignal.timeout(15000) })
      const value: unknown = await response.json()
      if (response.status !== 200) throw new Error(`Original HTTP ${route}: ${response.status} ${JSON.stringify(value)}`)
      return value
    }, catch: (error) => {
      progress.failedHTTP = { route, method: body === undefined ? "GET" : "POST", stage: progress.stage }
      return new Error(`Original HTTP ${route} at ${String(progress.stage)}: ${error instanceof Error ? error.message : "request failed"}`,
        { cause: error })
    } })
    const poll = <A, E, R>(effect: Effect.Effect<A | undefined, E, R>) => Effect.gen(function* () {
      for (const index of Array.from({ length: 400 }, (_, index) => index)) {
        const value = yield* effect
        if (value !== undefined) return value
        if (index === 399) return yield* Effect.die(new Error(`Bounded observation at ${String(progress.stage)}`))
        yield* Effect.sleep("100 millis")
      }
      return yield* Effect.die("Unreachable observation")
    })
    const census = () => Effect.gen(function* () {
      return {
        source: yield* db.all("SELECT source_id,message_id,proof_hash,snapshot_hash FROM im_task_source"),
        requests: yield* db.all("SELECT request_id,state,request_hash FROM im_task_request"),
        grants: yield* db.all("SELECT grant_id,state,revision,work_id,session_id,input_id,result_key FROM im_task_grant"),
        work: yield* db.all("SELECT work_id,admission_state,control_state,control_revision,outcome FROM work_execution"),
        sessions: yield* db.all("SELECT id,execution_claim_token FROM session"),
        inputs: yield* db.all("SELECT id,session_id,delivery,promoted_seq FROM session_input"),
        counts: yield* db.all("SELECT acquisition_id,state,record FROM work_count_acquisition ORDER BY created_at,acquisition_id"),
        dispatches: yield* db.all("SELECT state,charged_tokens FROM work_dispatch_reservation ORDER BY created_at,reservation_id"),
        providers: yield* db.all("SELECT attempt_id,state FROM session_provider_attempt ORDER BY created_at,attempt_id"),
        receipts: yield* db.all("SELECT state,outcome_artifact FROM session_v2_provider_turn_receipt ORDER BY request_ordinal"),
        tools: yield* db.all("SELECT state,effect_kind,(known_read_proof IS NOT NULL) known_read FROM session_v2_tool_effect"),
      }
    })
    progress.stage = "default-current-facade"
    yield* poll(http("/api/v1/im/status").pipe(Effect.map(Schema.decodeUnknownSync(IMStatusResponse)),
      Effect.map((value) => value.facade === "active" && value.kernel === "connected" ? value : undefined)))
    yield* http("/api/v1/im/groups/page?lane=protected&limit=2").pipe(Effect.map(Schema.decodeUnknownSync(GroupPageResponse)))
    yield* poll(http("/api/v1/im/status").pipe(Effect.map(Schema.decodeUnknownSync(IMStatusResponse)),
      Effect.map((value) => value.reader?.state === "ready" ? value : undefined)))
    progress.before = yield* census()
    yield* Effect.promise(() => fs.writeFile(ready, "original current reader", { mode: 0o600 }))
    progress.stage = "new-live-source"
    const source = yield* poll(db.get<{ local_message_id: string; metadata: string }>(
      "SELECT local_message_id,metadata FROM im_kernel_reader_message WHERE message_id='actual-kernel-work-source'"))
    const origin = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ firstSeen: Schema.Struct({ origin: Schema.String }) })))(source.metadata)
    assert.equal(origin.firstSeen.origin, "kernel_live")
    progress.stage = "formal-propose"
    const proposed = yield* http("/api/v1/im/tasks/requests", { clientRequestID: "notice-propose", messageID: source.local_message_id,
      auditedText: "Read the explicitly approved guard.test.ts bytes, then report the original marker in this conversation." })
      .pipe(Effect.map(Schema.decodeUnknownSync(RequestView)))
    const accept = { operationID: "notice-accept-original", expectedRevision: proposed.revision }
    const route = `/api/v1/im/tasks/requests/${proposed.id}`
    progress.stage = "accept-committed-response-body-lost"
    const lost = yield* Effect.tryPromise({ try: () => new Promise<{ status: number; bodyBytes: number }>((resolve, reject) => {
      const original = request(new URL(route + "/accept", listener.url), { method: "POST", headers, ca, rejectUnauthorized: true }, (response) => {
        // Headers are emitted only after the original handler committed its reply. No body
        // listener consumes the grant/session response; this client loses all response bytes.
        const status = response.statusCode ?? 0
        response.destroy()
        original.destroy()
        resolve({ status, bodyBytes: 0 })
      })
      original.on("error", reject)
      original.setTimeout(15000, () => original.destroy(new Error("Bounded original accept response")))
      original.end(JSON.stringify(accept))
    }), catch: (error) => error instanceof Error ? error : new Error("Original response loss probe failed") })
    assert.equal(lost.status, 200)
    progress.acceptResponseLoss = lost
    const accepted = yield* http(route).pipe(Effect.map(Schema.decodeUnknownSync(RequestView)))
    assert.equal(accepted.admission, "ready")
    assert(accepted.sessionID && accepted.workID && accepted.inputID)
    progress.accepted = accepted
    progress.stage = "actual-native-terminal"
    yield* poll(db.get<{ outcome: string }>(sql`SELECT outcome FROM work_execution WHERE work_id=${accepted.workID}`)
      .pipe(Effect.map((work) => work?.outcome === "succeeded" ? work : undefined)))
    yield* (yield* SessionExecution.Service).awaitIdle(SessionSchema.ID.make(accepted.sessionID))
    const resultOutbox = yield* poll(db.get<{ delivery_message_id: string; status: string }>(sql`
      SELECT delivery_message_id,status FROM im_reply_outbox WHERE session_id=${accepted.sessionID} AND id NOT LIKE 'imnotice_%'`))
    const resultDelivery = yield* poll(KernelDelivery.read(db, resultOutbox.delivery_message_id)
      .pipe(Effect.map((receipt) => receipt?.state === "acknowledged" ? receipt : undefined)))
    progress.resultDelivery = { state: resultDelivery.state, messageID: resultDelivery.binding.messageID }
    progress.stage = "original-exact-accept"
    const exactBefore = yield* census()
    const exact = yield* http(route + "/accept", accept).pipe(Effect.map(Schema.decodeUnknownSync(RequestView)))
    assert.equal(exact.workID, accepted.workID)
    assert.equal(exact.sessionID, accepted.sessionID)
    assert.equal(exact.inputID, accepted.inputID)
    yield* Effect.sleep("100 millis")
    assert.deepEqual(yield* census(), exactBefore)
    progress.exactAcceptZeroIncrement = true
    progress.stage = "current-operator-cancel"
    const state = yield* http(route + "/state").pipe(Effect.map(Schema.decodeUnknownSync(TaskState)))
    assert(state.grant && state.work)
    const cancel = { operationID: "notice-cancel-original", expectedGrantRevision: state.grant.revision,
      expectedControlRevision: state.work.controlRevision }
    const cancelled = yield* http(route + "/cancel", cancel)
    const cancelledExact = yield* http(route + "/cancel", cancel)
    assert.deepEqual(cancelledExact, cancelled)
    progress.cancel = cancelled
    progress.stage = "original-notice-collector-and-dispatch"
    const noticeRow = yield* poll(db.get<{ notice_id: string }>(sql`SELECT notice_id FROM im_task_status_notice
      WHERE request_id=${proposed.id} AND kind='cancel_requested'`))
    const notice = yield* IMTaskStatusNotice.read(db, noticeRow.notice_id)
    assert(notice)
    const delivery = yield* poll(KernelDelivery.read(db, notice.deliveryMessageID)
      .pipe(Effect.map((receipt) => receipt?.state === "acknowledged" ? receipt : undefined)))
    assert.equal((yield* db.get<{ content: string }>(sql`SELECT content FROM im_messages WHERE id=${notice.deliveryMessageID}`))?.content, notice.text)
    progress.notice = notice
    progress.noticeDelivery = { state: delivery.state, nativeID: delivery.kernel_message_id, messageID: notice.deliveryMessageID }
    progress.stage = "public-status-locator"
    const statusRoute = `/api/v1/im/messages/${notice.deliveryMessageID}/task-status`
    const located = yield* http(statusRoute).pipe(Effect.map(Schema.decodeUnknownSync(IMTaskStatusLocator.Result)))
    assert.equal(located.state, "available", JSON.stringify(located))
    if (located.state !== "available") return yield* Effect.die("Original status locator unavailable")
    assert.equal(located.notice.kind, "cancel_requested")
    assert.equal(located.task.grant?.state, "revoked")
    assert.equal(located.task.work?.controlState, "cancelled")
    assert.equal(located.task.work?.outcome, "succeeded")
    assert.equal(located.task.work?.hasExecutionClaim, false)
    const readBefore = yield* census()
    assert.deepEqual(yield* http(statusRoute).pipe(Effect.map(Schema.decodeUnknownSync(IMTaskStatusLocator.Result))), located)
    assert.deepEqual(yield* census(), readBefore)
    progress.locator = located
    progress.stage = "original-root-remote-status"
    assert.equal(delivery.binding.version, 1)
    assert.equal(delivery.binding.conversationType, 1)
    yield* poll(db.get<{ id: string }>(sql`SELECT id FROM im_reply_outbox WHERE id=${notice.outboxID} AND status='delivered'`))
    const tuple = Schema.decodeUnknownSync(IMRemoteTaskResult.Tuple)({ version: 1,
      realm: delivery.binding.source.realm, appkey: delivery.binding.source.appkey,
      orgID: String(delivery.binding.source.orgID), kernelMessageID: delivery.kernel_message_id,
      senderID: delivery.binding.source.senderID, receiverID: delivery.binding.conversationID,
      conversationType: delivery.binding.conversationType, conversationID: delivery.binding.source.senderID })
    const readonlyFacts = () => Effect.gen(function* () {
      return { execution: yield* census(),
        notices: yield* db.all("SELECT * FROM im_task_status_notice ORDER BY notice_id"),
        outbox: yield* db.all("SELECT * FROM im_reply_outbox ORDER BY id"),
        delivery: yield* db.all("SELECT * FROM im_kernel_delivery ORDER BY message_id") }
    })
    const remoteBefore = yield* readonlyFacts()
    const remote = yield* http("/api/v1/im/tasks/remote-status", { tuple }).pipe(Effect.map(Schema.decodeUnknownSync(IMRemoteTaskStatus.Lookup)))
    assert.deepEqual(remote, located)
    assert.deepEqual(yield* http("/api/v1/im/tasks/remote-status", { tuple }).pipe(Effect.map(Schema.decodeUnknownSync(IMRemoteTaskStatus.Lookup))), remote)
    const substituted = yield* http("/api/v1/im/tasks/remote-status", { tuple: { ...tuple, kernelMessageID: tuple.kernelMessageID + "-substituted" } })
      .pipe(Effect.map(Schema.decodeUnknownSync(IMRemoteTaskStatus.Lookup)))
    assert.deepEqual(substituted, { version: 1, state: "unavailable", code: "remote_status_unlinked" })
    assert.deepEqual(yield* readonlyFacts(), remoteBefore)
    progress.remoteStatus = { tuple, located: remote, substituted, exact: true, readonly: true,
      protectedTables: ["im_task_status_notice", "im_reply_outbox", "im_kernel_delivery"] }
    progress.after = yield* census()
    progress.stage = "complete"
  }).pipe(Effect.provide(ServerAuth.Config.defaultLayer), Effect.scoped, Effect.exit))
  if (Exit.isFailure(outcome)) progress.error = Cause.pretty(outcome.cause)
  await fs.writeFile(output, JSON.stringify(progress), { mode: 0o600 })
  if (Exit.isFailure(outcome)) throw new Error(`Actual notice at ${String(progress.stage)}: ${Cause.pretty(outcome.cause)}`)
} })
