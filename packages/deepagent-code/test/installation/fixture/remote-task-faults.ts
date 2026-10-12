// Signed diagnostic entry only. Every source/admission/execution/result boundary is the
// original Server Root; this fixture never installs a verifier or writes terminal state.
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { Cause, Effect, Exit, Schema } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { contentDigest } from "@deepagent-code/core/contract/digest"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { AppRuntime } from "@/effect/app-runtime"
import { Server } from "@/server/server"
import { ServerAuth } from "@/server/auth"
import { LocalTaskAuthority } from "@/im/local-task-authority"
import { cmd } from "@/cli/cmd/cmd"
import { GroupPageResponse, IMStatusResponse, IMTaskResultResponse } from "@/server/routes/instance/httpapi/groups/im"
import { RequestView } from "@/im/task-history.schema"

export const DebugCommand = cmd({
  command: "debug",
  handler: async () => {
    const output = process.env.DAC_KERNEL_WORK_RESULT
    const signal = process.env.DAC_KERNEL_WORK_READY
    const caPath = process.env.DAC_KERNEL_WORK_CA
    const keyPath = process.env.DAC_KERNEL_WORK_TLS_KEY
    if (!output || !signal || !caPath || !keyPath) throw new Error("Private kernel Work fixture paths are required")
    const ca = await fs.readFile(caPath, "utf8")
    const key = await fs.readFile(keyPath, "utf8")
    const mode = process.env.DAC_REMOTE_FAULT_MODE
    if (!["before_dispatch", "lost_ack", "offline_cancel"].includes(mode ?? "")) throw new Error("Private fault mode required")
    const progress: Record<string, unknown> = { stage: "root", scope: "actual-signed-kernel-work-private-transport" }
    const outcome = await AppRuntime.runPromise(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const auth = yield* ServerAuth.Config
      const configured = yield* LocalTaskAuthority.configured(auth)
      yield* LocalTaskAuthority.authenticatePassword(db, configured.runtime, auth.username, configured.password)
      const listener = yield* Effect.acquireRelease(
        Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0, tls: { key, cert: ca } })),
        (listener) => Effect.promise(() => listener.stop(true)),
      )
      const request = (route: string, body?: unknown) => Effect.tryPromise({
        try: async () => {
          const response = await fetch(new URL(route, listener.url), {
            method: body === undefined ? "GET" : "POST",
            headers: { "content-type": "application/json", authorization: ServerAuth.header({ username: auth.username,
              password: configured.password })!, "x-deepagent-code-directory": process.cwd() },
            body: body === undefined ? undefined : JSON.stringify(body),
            tls: { rejectUnauthorized: true, ca },
            signal: AbortSignal.timeout(15_000),
          })
          const value: unknown = await response.json()
          if (response.status !== 200) throw new Error(`Original HTTP ${route} refused ${response.status}: ${JSON.stringify(value)}`)
          return value
        }, catch: (error) => error instanceof Error ? error : new Error("Original HTTP request failed"),
      })
      const poll = <A, E, R>(effect: Effect.Effect<A | undefined, E, R>) => Effect.gen(function* () {
        for (const attempt of Array.from({ length: 400 }, (_, index) => index)) {
          const value = yield* effect
          if (value !== undefined) return value
          if (attempt === 399) return yield* Effect.die(new Error(`Bounded observation timed out at ${String(progress.stage)}`))
          yield* Effect.sleep("100 millis")
        }
        return yield* Effect.die(new Error("Unreachable private observation"))
      })
      const census = () => Effect.gen(function* () {
        return {
          source: yield* db.all("SELECT source_id,message_id,proof_hash,snapshot_hash FROM im_task_source"),
          requests: yield* db.all("SELECT request_id,state,source_id,request_hash FROM im_task_request"),
          grants: yield* db.all("SELECT grant_id,work_id,session_id,input_id,result_key,state,record_hash FROM im_task_grant"),
          work: yield* db.all("SELECT work_id,session_id,input_id,admission_state,control_state,outcome FROM work_execution"),
          sessions: yield* db.all("SELECT id,project_id,directory,execution_claim_token FROM session"),
          inputs: yield* db.all("SELECT id,session_id,delivery,promoted_seq FROM session_input"),
          activities: yield* db.all("SELECT activity_id,session_id,state,final_message_id FROM session_activity"),
          counts: yield* db.all("SELECT work_id,state,revision,record FROM work_count_acquisition ORDER BY created_at,acquisition_id"),
          dispatches: yield* db.all("SELECT work_id,state,reserved_total_tokens,charged_tokens FROM work_dispatch_reservation ORDER BY created_at,reservation_id"),
          providers: yield* db.all("SELECT session_id,state FROM session_provider_attempt ORDER BY created_at,attempt_id"),
          receipts: yield* db.all("SELECT receipt_id,session_id,state,outcome_artifact FROM session_v2_provider_turn_receipt ORDER BY request_ordinal"),
          tools: yield* db.all("SELECT state,effect_kind,(known_read_proof IS NOT NULL) known_read FROM session_v2_tool_effect"),
          toolAdmissions: yield* db.all("SELECT receipt_id,tool_call_id,tool_name,effect_kind FROM session_v2_tool_effect_admission"),
          outbox: yield* db.all("SELECT id,session_id,group_id,trigger_message_id,reply_message_id,status,attempts FROM im_reply_outbox"),
        }
      })
      progress.stage = "default-facade-exchange"
      const status = yield* poll(request("/api/v1/im/status").pipe(Effect.map(Schema.decodeUnknownSync(IMStatusResponse)),
        Effect.map((value) => value.facade === "active" && value.kernel === "connected" ? value : undefined)))
      assert.equal(status.identity?.uuid, "receiver")
      assert.equal(status.identity?.orgID, 1)
      progress.stage = "current-reader-before-publish"
      yield* request("/api/v1/im/groups/page?lane=protected&limit=2").pipe(Effect.map(Schema.decodeUnknownSync(GroupPageResponse)))
      yield* poll(request("/api/v1/im/status").pipe(Effect.map(Schema.decodeUnknownSync(IMStatusResponse)),
        Effect.map((value) => value.reader?.state === "ready" ? value : undefined)))
      progress.before = yield* census()
      yield* Effect.promise(() => fs.writeFile(signal, "original current reader ready", { mode: 0o600 }))
      progress.stage = "original-live-message"
      const source = yield* poll(db.get<{ local_message_id: string; metadata: string }>(
        "SELECT local_message_id,metadata FROM im_kernel_reader_message WHERE message_id='actual-kernel-work-source'"))
      const first = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(source.metadata)
      if (typeof first !== "object" || first === null || !("firstSeen" in first) || typeof first.firstSeen !== "object" ||
        first.firstSeen === null || !("origin" in first.firstSeen)) throw new Error("Original live metadata is unavailable")
      assert.equal(first.firstSeen.origin, "kernel_live")
      const auditedText = "Read the explicitly approved guard.test.ts bytes, then report the original marker in this conversation."
      progress.stage = "formal-http-propose"
      const proposed = yield* request("/api/v1/im/tasks/requests", { clientRequestID: "actual-kernel-work-propose",
        messageID: source.local_message_id, auditedText }).pipe(Effect.map(Schema.decodeUnknownSync(RequestView)))
      assert.equal(proposed.state, "proposed")
      progress.proposed = proposed
      progress.stage = "formal-http-accept"
      const acceptPayload = { operationID: "actual-kernel-work-accept", expectedRevision: proposed.revision }
      const accepted = yield* request(`/api/v1/im/tasks/requests/${proposed.id}/accept`, acceptPayload)
        .pipe(Effect.map(Schema.decodeUnknownSync(RequestView)))
      assert.equal(accepted.admission, "ready")
      assert.ok(accepted.sessionID)
      assert.ok(accepted.workID)
      progress.accepted = accepted
      progress.stage = "actual-terminal-and-prepared-result"
      const outbox = yield* poll(db.get<{ id: string; delivery_message_id: string; status: string }>(sql`
        SELECT id,delivery_message_id,status FROM im_reply_outbox WHERE session_id=${accepted.sessionID}`))
      const messageID = outbox.delivery_message_id
      assert.equal(messageID, `imsg_reply_${contentDigest(outbox.id).slice(0, 40)}`)
      yield* poll(KernelDelivery.read(db, messageID).pipe(Effect.map((value) => value?.state === "prepared" || value?.state === "unknown" || value?.state === "dispatched" ? value : undefined)))
      const execution = yield* SessionExecution.Service
      yield* execution.awaitIdle(SessionSchema.ID.make(accepted.sessionID))
      const statePath = `/api/v1/im/tasks/requests/${proposed.id}/state`
      const cancelPath = `/api/v1/im/tasks/requests/${proposed.id}/cancel`
      const stateSchema = Schema.Struct({ grant: Schema.Struct({ revision: Schema.Number }),
        work: Schema.Struct({ controlRevision: Schema.Number, outcome: Schema.String }),
        delivery: Schema.Struct({ receiptState: Schema.NullOr(Schema.String) }) })
      const cancelOriginal = () => Effect.gen(function* () {
        const current = Schema.decodeUnknownSync(stateSchema)(yield* request(statePath))
        const body = { operationID: "fault-cancel-original", expectedGrantRevision: current.grant.revision,
          expectedControlRevision: current.work.controlRevision }
        const cancelled = yield* request(cancelPath, body)
        const exact = yield* request(cancelPath, body)
        const receipt = Schema.Struct({ receipt: Schema.Unknown })
        assert.deepEqual(Schema.decodeUnknownSync(receipt)(exact).receipt, Schema.decodeUnknownSync(receipt)(cancelled).receipt)
        progress.cancel = cancelled
        return body
      })
      if (mode === "before_dispatch") {
        progress.stage = "prepared-before-current-authority-revoke"
        yield* cancelOriginal()
        yield* Effect.promise(() => fs.writeFile(signal + ".revoked", "durable current control committed", { mode: 0o600 }))
        yield* poll(Effect.promise(() => fs.stat(signal + ".drain-observed").then(() => true, () => undefined)))
        yield* Effect.sleep("150 millis")
        assert.equal((yield* KernelDelivery.read(db, messageID))?.state, "prepared")
        progress.delivery = { state: "prepared" }
      } else {
        progress.stage = "original-pub-unknown-and-reconnect"
        yield* poll(KernelDelivery.read(db, messageID).pipe(Effect.map((value) => value?.state === "unknown" ? value : undefined)))
        yield* poll(request("/api/v1/im/status").pipe(Effect.map(Schema.decodeUnknownSync(IMStatusResponse)),
          Effect.map((value) => value.kernel === "connected" ? value : undefined)))
        const protectedBefore = yield* census()
        const exactAccept = yield* request(`/api/v1/im/tasks/requests/${proposed.id}/accept`, acceptPayload)
          .pipe(Effect.map(Schema.decodeUnknownSync(RequestView)))
        assert.equal(exactAccept.workID, accepted.workID)
        assert.equal(exactAccept.sessionID, accepted.sessionID)
        // The original thirty-second fallback scans the same durable receipts.
        // No fixture engine/service is installed to cause a second delivery.
        yield* Effect.sleep("31 seconds")
        assert.deepEqual(yield* census(), protectedBefore)
        const located = yield* request(`/api/v1/im/messages/${messageID}/task-result`)
          .pipe(Effect.map(Schema.decodeUnknownSync(IMTaskResultResponse)))
        assert.equal(located.state, "unavailable")
        progress.result = located
        const remote = yield* request("/api/v1/im/tasks/remote-result", { tuple: {
          version: 1, realm: new URL(process.env.DEEPAGENT_IM_FACADE_URL!).href,
          appkey: "private-native-kernel-work", orgID: "1", kernelMessageID: "actual-kernel-work-result",
          senderID: "receiver", receiverID: "sender", conversationType: 1, conversationID: "receiver",
        } }).pipe(Effect.map(Schema.decodeUnknownSync(Schema.Struct({ state: Schema.String }))))
        assert.equal(remote.state, "unavailable")
        assert.deepEqual(yield* census(), protectedBefore)
        progress.remote = remote
        if (mode === "offline_cancel") {
          progress.stage = "source-offline-current-operator-cancel"
          yield* Effect.promise(() => fs.writeFile(signal + ".offline", "disconnect original source", { mode: 0o600 }))
          yield* poll(Effect.promise(() => fs.stat(signal + ".offline-done").then(() => true, () => undefined)))
          yield* cancelOriginal()
          assert.equal((yield* KernelDelivery.read(db, messageID))?.state, "unknown")
        }
        progress.delivery = { state: "unknown" }
      }
      progress.after = yield* census()
      progress.messageID = messageID
      progress.stage = "complete"
    }).pipe(Effect.provide(ServerAuth.Config.defaultLayer), Effect.scoped, Effect.exit))
    if (Exit.isFailure(outcome)) {
      progress.error = Cause.pretty(outcome.cause)
      progress.failureFacts = await AppRuntime.runPromise(Effect.gen(function* () {
        const db = (yield* Database.Service).db
        return { work: yield* db.all("SELECT work_id,admission_state,control_state,outcome FROM work_execution"),
          counts: yield* db.all("SELECT state FROM work_count_acquisition"),
          dispatches: yield* db.all("SELECT state,charged_tokens FROM work_dispatch_reservation"),
          providers: yield* db.all("SELECT state,error_code FROM session_provider_attempt"),
          receipts: yield* db.all("SELECT state,error_code FROM session_v2_provider_turn_receipt"),
          outbox: yield* db.all("SELECT status,last_error FROM im_reply_outbox") }
      }))
    }
    await fs.writeFile(output, JSON.stringify(progress), { mode: 0o600 })
    if (Exit.isFailure(outcome)) throw new Error(`Actual kernel Work failed at ${String(progress.stage)}: ${Cause.pretty(outcome.cause)}`)
  },
})
