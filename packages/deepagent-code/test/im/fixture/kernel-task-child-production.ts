// Signed diagnostic entry only. Every source/admission/execution/result boundary is the
// original Server Root; this fixture never installs a verifier or writes terminal state.
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { sql } from "drizzle-orm"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { command } from "@/cli/cmd/operator"
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
    if (process.env.DAC_KERNEL_CHILD_DIAG_POLICY) {
      const database = Database.defaultLayer
      const out = await Effect.runPromise(command({ action: "enroll", operationID: "kernel-work-enroll",
        policyPath: process.env.DAC_KERNEL_CHILD_DIAG_POLICY }).pipe(
        Effect.provide(LocationIdentity.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer))),
        Effect.provide(database), Effect.provide(ServerAuth.Config.defaultLayer), Effect.scoped, Effect.exit))
      await fs.writeFile(process.env.DAC_KERNEL_CHILD_DIAG_RESULT!, JSON.stringify({
        state: Exit.isFailure(out) ? "refused" : "enrolled", cause: Exit.isFailure(out) ? Cause.pretty(out.cause) : undefined,
      }), { mode: 0o600 })
      return
    }
    const output = process.env.DAC_KERNEL_WORK_RESULT
    const signal = process.env.DAC_KERNEL_WORK_READY
    const caPath = process.env.DAC_KERNEL_WORK_CA
    const keyPath = process.env.DAC_KERNEL_WORK_TLS_KEY
    if (!output || !signal || !caPath || !keyPath) throw new Error("Private kernel child Work fixture paths are required")
    const ca = await fs.readFile(caPath, "utf8")
    const key = await fs.readFile(keyPath, "utf8")
    const progress: Record<string, unknown> = { stage: "root", scope: "actual-signed-kernel-child-work-private-transport" }
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
        for (const attempt of Array.from({ length: 240 }, (_, index) => index)) {
          const value = yield* effect
          if (value !== undefined) return value
          if (attempt === 239) return yield* Effect.die(new Error(`Bounded observation timed out at ${String(progress.stage)}`))
          yield* Effect.sleep("100 millis")
        }
        return yield* Effect.die(new Error("Unreachable private observation"))
      })
      const census = () => Effect.gen(function* () {
        return {
          source: yield* db.all("SELECT source_id,message_id,proof_hash,snapshot_hash FROM im_task_source"),
          requests: yield* db.all("SELECT request_id,state,source_id,request_hash FROM im_task_request"),
          grants: yield* db.all("SELECT grant_id,work_id,session_id,input_id,result_key,state,record_hash FROM im_task_grant"),
          work: yield* db.all("SELECT work_id,root_work_id,parent_work_id,session_id,input_id,admission_state,control_state,outcome FROM work_execution"),
          sessions: yield* db.all("SELECT id,project_id,directory,execution_claim_token FROM session"),
          inputs: yield* db.all("SELECT id,session_id,delivery,promoted_seq FROM session_input"),
          activities: yield* db.all("SELECT activity_id,session_id,state,final_message_id FROM session_activity"),
          counts: yield* db.all("SELECT work_id,state,revision,record FROM work_count_acquisition ORDER BY created_at,acquisition_id"),
          dispatches: yield* db.all("SELECT work_id,state,reserved_total_tokens,charged_tokens FROM work_dispatch_reservation ORDER BY created_at,reservation_id"),
          providers: yield* db.all("SELECT session_id,state FROM session_provider_attempt ORDER BY created_at,attempt_id"),
          receipts: yield* db.all("SELECT receipt_id,session_id,state,outcome_artifact FROM session_v2_provider_turn_receipt ORDER BY request_ordinal"),
          tools: yield* db.all("SELECT state,effect_kind,(known_read_proof IS NOT NULL) known_read FROM session_v2_tool_effect"),
          toolAdmissions: yield* db.all("SELECT receipt_id,tool_call_id,tool_name,effect_kind FROM session_v2_tool_effect_admission"),
          childGrants: yield* db.all("SELECT child_work_id,root_work_id,parent_work_id,task_run_id,admission_id,child_session_id,record_hash,expires_at,record FROM work_child_authority"),
          taskRuns: yield* db.all("SELECT run_id,state,child_session_id,delivery_mode,workspace_mode,raw_result_message_id,time_settled,error FROM task_run"),
          taskReceipts: yield* db.all("SELECT run_id,state,child_session_id,outcome_hash FROM session_v2_task_run_receipt"),
          taskCalls: yield* db.all("SELECT * FROM session_v2_task_call_admission"),
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
      const auditedText = "Delegate one fresh foreground shared task to explore to read only the explicitly approved guard.test.ts bytes, then report the original marker in this conversation."
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
      progress.stage = "canonical-runner-and-outbox"
      const outbox = yield* poll(Effect.gen(function* () {
        const failed = yield* db.get<{ error_code: string }>(sql`SELECT error_code FROM session_provider_attempt
          WHERE session_id=${accepted.sessionID} AND state IN ('failed','indeterminate') LIMIT 1`)
        if (failed) return yield* Effect.die(new Error(`Original provider stopped: ${failed.error_code}`))
        return yield* db.get<{ id: string; group_id: string; status: string }>(sql`
          SELECT id,group_id,status FROM im_reply_outbox WHERE session_id=${accepted.sessionID} AND status='delivered'`)
      }))
      const messageID = `imsg_reply_${contentDigest(outbox.id).slice(0, 40)}`
      const acknowledged = yield* poll(KernelDelivery.read(db, messageID).pipe(
        Effect.map((value) => value?.state === "acknowledged" ? value : undefined)))
      assert.ok(acknowledged.kernel_message_id)
      yield* (yield* SessionExecution.Service).awaitIdle(SessionSchema.ID.make(accepted.sessionID))
      progress.stage = "formal-http-result"
      const located = yield* request(`/api/v1/im/messages/${messageID}/task-result`)
        .pipe(Effect.map(Schema.decodeUnknownSync(IMTaskResultResponse)))
      assert.equal(located.state, "available", JSON.stringify(located))
      if (located.state !== "available") throw new Error("Original result is unavailable")
      assert.equal(located.placement.sessionID, accepted.sessionID)
      assert.equal(located.attempt.workID, accepted.workID)
      assert.equal(located.attempt.outcome, "succeeded")
      assert.equal(located.placement.directory, process.cwd())
      progress.result = located
      progress.delivery = { state: acknowledged.state, kernelMessageID: acknowledged.kernel_message_id,
        bindingHash: acknowledged.binding_hash }
      progress.after = yield* census()
      progress.stage = "exact-accept-retry"
      progress.retry = yield* request(`/api/v1/im/tasks/requests/${proposed.id}/accept`, acceptPayload)
        .pipe(Effect.map(Schema.decodeUnknownSync(RequestView)))
      assert.deepEqual(yield* census(), progress.after)
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
          childGrants: yield* db.all("SELECT child_work_id,root_work_id,parent_work_id,task_run_id,admission_id,child_session_id,record_hash,expires_at,record FROM work_child_authority"),
          taskRuns: yield* db.all("SELECT run_id,state,child_session_id,delivery_mode,workspace_mode,raw_result_message_id,time_settled,error FROM task_run"),
          taskReceipts: yield* db.all("SELECT run_id,state,child_session_id,outcome_hash FROM session_v2_task_run_receipt"),
          taskCalls: yield* db.all("SELECT * FROM session_v2_task_call_admission"),
          tools: yield* db.all("SELECT state,effect_kind FROM session_v2_tool_effect"),
          admissions: yield* db.all("SELECT admission_id,receipt_id,tool_call_id,tool_name FROM session_v2_tool_effect_admission"),
          children: yield* db.all("SELECT child_work_id,parent_work_id,task_run_id FROM work_child_authority"),
          outbox: yield* db.all("SELECT status,last_error FROM im_reply_outbox") }
      }))
    }
    await fs.writeFile(output, JSON.stringify(progress), { mode: 0o600 })
    if (Exit.isFailure(outcome)) throw new Error(`Actual kernel child Work failed at ${String(progress.stage)}: ${Cause.pretty(outcome.cause)}`)
  },
})
