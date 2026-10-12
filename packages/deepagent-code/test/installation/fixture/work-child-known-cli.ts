// Narrow child cold-recovery successor of the original signed Work CLI diagnostic.
// Only the real parent Tool.Success blocks; child events continue through the actual runner.
// Signed test command replacement. Production has no debug grant/profile override. Source
// creation uses the actual authenticated HTTP handlers; explicit acceptance below uses the
// real CLI password witness and existing core authority, never a fixture verifier/Profile.
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createServer } from "node:net"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { IMTaskAuthority } from "@deepagent-code/core/im/task-authority"
import { LocalTaskAuth } from "@deepagent-code/core/im/local-task-auth"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { WorkAdmission } from "@deepagent-code/core/session/work-admission"
import { WorkAuthority } from "@deepagent-code/core/session/work-authority"
import { SessionV2 } from "@deepagent-code/core/session"
import { AgentV2 } from "@deepagent-code/core/agent"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { LocalTaskAuthority } from "@/im/local-task-authority"
import { AppRuntime } from "@/effect/app-runtime"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Server } from "@/server/server"
import { ServerAuth } from "@/server/auth"
import { cmd } from "@/cli/cmd/cmd"
import { WorkExecutionProfile } from "@deepagent-code/core/session/work-execution-profile"
import { WorkTaskKnownProof } from "@deepagent-code/core/session/work-task-known-proof"
import { WorkTaskKnownProofTable } from "@deepagent-code/core/session/work-task-known-proof.sql"
import { WorkKnownRecoveryV2 } from "@deepagent-code/core/session/work-known-recovery-v2"

export const DebugCommand = cmd({
  command: "debug <mode>",
  builder: (yargs) => yargs.positional("mode", { type: "string", demandOption: true }),
  handler: async (args) => {
    if (args.mode === "diagnose-enroll") {
      const { command } = await import("@/cli/cmd/operator")
      const { LocationIdentity } = await import("@deepagent-code/core/context-federation/identity")
      const { FSUtil } = await import("@deepagent-code/core/fs-util")
      const database = Database.defaultLayer
      const { WorkFileHelper } = await import("@/installation/work-file-helper")
      const { NativeRouteCapture } = await import("@/installation/native-route-capture")
      const inspected = await Effect.runPromise(WorkFileHelper.inspectRoot(process.cwd()).pipe(Effect.scoped, Effect.exit))
      const selection = await Effect.runPromise(NativeRouteCapture.projectSelection({ directory: process.cwd(), agentID: "auto", toolIDs: ["read"] }).pipe(
        Effect.provide(NativeRouteCapture.nativeLayer), Effect.provide(database), Effect.scoped, Effect.exit,
      ))
      const result = await Effect.runPromise(command({ action: "enroll", operationID: "enroll", policyPath: path.join(process.cwd(), "../policy.json") }).pipe(
        Effect.provide(LocationIdentity.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer))),
        Effect.provide(database), Effect.provide(ServerAuth.Config.defaultLayer), Effect.scoped, Effect.exit,
      ))
      await fs.writeFile(process.env.DAC_WORK_PRODUCTION_RESULT!, JSON.stringify({ inspect: Exit.isFailure(inspected) ? Cause.pretty(inspected.cause) : inspected.value, selection: Exit.isFailure(selection) ? Cause.pretty(selection.cause) : selection.value, success: Exit.isSuccess(result), code: failureCode(result), cause: Exit.isFailure(result) ? Cause.pretty(result.cause) : null }))
      return
    }
    const progress: Record<string, unknown> = { mode: args.mode }
    const directory = process.cwd()
    const output = process.env.DAC_WORK_PRODUCTION_RESULT!
    const identityFile = path.join(directory, "work-identity.json")
    const observe = () => AppRuntime.runPromise(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      return { work: yield* db.all("SELECT work_id,admission_state,control_state,outcome FROM work_execution"),
        counts: yield* db.all("SELECT state,revision,record FROM work_count_acquisition"),
        dispatches: yield* db.all("SELECT state,reserved_total_tokens,charged_tokens FROM work_dispatch_reservation"),
        receipts: yield* db.all("SELECT state FROM session_v2_provider_turn_receipt"),
        inputs: yield* db.all("SELECT id,promoted_seq FROM session_input"),
        activities: yield* db.all("SELECT state,settled_at FROM session_activity"),
        tools: yield* db.all("SELECT state,effect_kind AS kind,(known_read_proof IS NOT NULL OR known_write_proof IS NOT NULL OR known_command_proof IS NOT NULL) AS has_proof FROM session_v2_tool_effect"),
        pendingTools: yield* db.all("SELECT a.tool_name,a.effect_kind FROM session_v2_tool_effect_admission a LEFT JOIN session_v2_tool_effect e ON e.receipt_id=a.receipt_id AND e.tool_call_id=a.tool_call_id WHERE e.effect_id IS NULL"),
        stages: yield* db.all("SELECT state,reserved_bytes,observed_retained_bytes,released_at FROM work_write_stage"),
        meter: yield* db.all("SELECT custody_count,retained_bytes,audit_count FROM work_write_stage_meter"),
        commands: yield* db.all("SELECT state,outcome,reserved_bytes,observed_retained_bytes,released_at FROM work_command_intent"),
        commandMeter: yield* db.all("SELECT custody_count,retained_bytes,audit_count FROM work_command_meter") }
    }))
    // The embedded listener must adopt the already-owned root/memo map, as production CLI/TUI does.
    await AppRuntime.runPromise(Database.Service)
    const reservation = createServer()
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve))
    const address = reservation.address()
    if (!address || typeof address === "string") throw new Error("missing private port")
    await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()))
    const listener = await Server.listen({ hostname: "127.0.0.1", port: address.port })
    const auth = ServerAuth.header({ username: "fixture-operator", password: "fixture-operator-password" })!
    const request = async (route: string, body: unknown = undefined, authenticated = true) => {
      const response = await fetch(new URL(route, listener.url), { method: body === undefined ? "GET" : "POST", headers: {
        "content-type": "application/json", "x-deepagent-code-directory": directory,
        ...(authenticated ? { authorization: auth } : {}),
      }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) })
      const text = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`)
      return JSON.parse(text)
    }
    try {
      if (args.mode === "proof-oracle") {
        progress.proof = await AppRuntime.runPromise(Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const installed = yield* WorkExecutionProfile.Services
          if (!installed.taskKnownProof) return yield* Effect.die("Actual signed NativeTask proof service is missing")
          const original = yield* db.select({ admissionID: WorkTaskKnownProofTable.admission_id }).from(WorkTaskKnownProofTable).get()
          if (!original) return yield* Effect.die("Actual original NativeTask proof is missing")
          const record = yield* WorkTaskKnownProof.read(db,original.admissionID).pipe(Effect.provideService(WorkTaskKnownProof.Authority,installed.taskKnownProof))
          if (!record) return yield* Effect.die("Actual original NativeTask MAC did not authenticate")
          const cloned = yield* db.transaction((tx) => installed.taskKnownProof!.seal(tx,Object.freeze({}) as WorkTaskKnownProof.Settlement,"tool_clone")).pipe(Effect.exit)
          const wrong = yield* installed.taskKnownProof.verify({...record,outcomeHash:"0".repeat(64)},"0".repeat(64)).pipe(Effect.exit)
          const copied = yield* WorkKnownRecoveryV2.withContinuation({recoveryID:"wrecover2_copy",workID:record.parentWorkID,
            sessionID:record.parentSessionID,requestID:"copy",action:"recover_only",oldClaimToken:record.sessionClaimToken,
            controlRevision:record.parentRevision,createdAt:record.createdAt,replayed:false,continuation:"not_started"},
            Effect.die("Copied continuation executed")).pipe(Effect.exit)
          return {originalAuthenticated:true,clonedCode:failureCode(cloned),wrongCode:failureCode(wrong),copiedCode:failureCode(copied)}
        }))
        progress.after = await observe()
      } else if (args.mode === "observe") {
        progress.after = await observe()
        progress.recovery = await AppRuntime.runPromise(Effect.gen(function* () {
          const db = (yield* Database.Service).db
          return { claims: yield* db.all("SELECT id,execution_claim_token token FROM session WHERE id IN (SELECT session_id FROM work_execution)"),
            leases: yield* db.all("SELECT owner_token,released_at,lease_expires_at FROM session_provider_owner_lease"),
            receipts: yield* db.all("SELECT recovery_id,old_claim_token,control_revision,record_hash FROM work_known_recovery"),
            resumes: yield* db.all("SELECT recovery_id,request_id,record_hash FROM work_known_recovery_resume") }
        }))
      } else if (args.mode === "ordinary") {
        const ordinary = await AppRuntime.runPromise(Effect.gen(function* () {
          const sessions = yield* SessionV2.Service
          const session = yield* sessions.create({ agent: AgentV2.ID.make("auto"),
            model: ModelV2.Ref.make({ providerID: ProviderV2.ID.make("openai"), id: ModelV2.ID.make("gpt-4.1-2025-04-14") }),
            permissions: [], location: { directory: AbsolutePath.make(directory) } })
          yield* sessions.prompt({ sessionID: session.id, prompt: new Prompt({ text: "Ordinary explicit user request." }), resume: false })
          yield* (yield* SessionExecution.Service).resume(session.id)
          return session.id
        }))
        progress.sessionID = ordinary
        progress.after = await observe()
      } else if (args.mode === "im-task-cold") {
        const stored = JSON.parse(await fs.readFile(identityFile, "utf8")) as { requestID: string; expectedRevision: number; groupID: string }
        progress.before = await observe()
        progress.accepted = await request(`/api/v1/im/tasks/requests/${stored.requestID}/accept`, {
          operationID: "explicit-http-accept", expectedRevision: stored.expectedRevision,
        })
        progress.messages = await request(`/api/v1/im/groups/${stored.groupID}/messages?limit=50`)
        progress.after = await observe()
      } else if (args.mode === "cold" || args.mode === "resume") {
        const stored = JSON.parse(await fs.readFile(identityFile, "utf8")) as { sessionID: string; workID: string }
        progress.before = await observe()
        const outcome = await AppRuntime.runPromise(Effect.gen(function* () {
          return yield* (yield* SessionExecution.Service).resume(SessionSchema.ID.make(stored.sessionID))
        }).pipe(Effect.exit))
        progress.execution = Exit.isSuccess(outcome) ? "completed" : Cause.pretty(outcome.cause)
        progress.executionCode = failureCode(outcome)
        progress.after = await observe()
      } else {
        const denied = await fetch(new URL("/api/v1/im/groups", listener.url), { method: "POST",
          headers: { "content-type": "application/json", "x-deepagent-code-directory": directory },
          body: JSON.stringify({ type: "project", name: "untrusted" }) })
        progress.unauthenticated = denied.status
        assert.equal(denied.status, 401)
        const group = await request("/api/v1/im/groups", { type: "project", name: "Explicit work fixture" })
        await request(`/api/v1/im/tasks/conversations/${group.id}`, { operationID: "enable", targetID: "review", expectedRevision: 0 })
        const message = await request(`/api/v1/im/groups/${group.id}/messages`, { type: "text", senderType: "user",
          content: process.env.DAC_WORK_COMMAND_CASE ? "Run the explicitly approved Bun build recipe on input.ts in its private workspace, then publish the authenticated output.js artifact to built.js. Report the real exit and any refusal; never substitute preview text for output bytes."
            : process.env.DAC_WORK_WRITE_CASE ? `Read the explicitly approved approved.txt file, then ${process.env.DAC_WORK_WRITE_CASE === "project-write-create" ? "create created.txt" : "replace approved.txt"} with the requested new content. Honor the observed file version and report any refusal without overwriting a newer version.`
            : process.env.DAC_WORK_PROJECT ? "Delegate one fresh foreground shared explore task to read only guard.test.ts and report its original marker." : "Delegate one fresh foreground shared explore task to read only guard.test.ts and report its original marker.", clientRequestID: "source-message" })
        const proposal = await request("/api/v1/im/tasks/requests", { clientRequestID: "propose", messageID: message.id, auditedText: message.content })
        progress.requestID = proposal.id
        if (args.mode === "im-task") {
          const accepted = await request(`/api/v1/im/tasks/requests/${proposal.id}/accept`, {
            operationID: "explicit-http-accept", expectedRevision: proposal.revision,
          })
          progress.accepted = accepted
          assert.equal(accepted.admission, "ready")
          await fs.writeFile(identityFile, JSON.stringify({ workID: accepted.workID, sessionID: accepted.sessionID,
            requestID: proposal.id, expectedRevision: proposal.revision, groupID: group.id }))
          const deadline = Date.now() + 60000
          while (true) {
            const messages = await request(`/api/v1/im/groups/${group.id}/messages?limit=50`)
            const reply = messages.messages.find((value: { senderType: string; content: string }) => value.senderType === "agent")
            if (reply) { progress.messages = messages; progress.reply = reply; break }
            if (Date.now() >= deadline) throw new Error("Actual Work reply did not reach the original conversation")
            await Bun.sleep(250)
          }
          const current = await request(`/api/v1/im/tasks/requests/${proposal.id}`)
          progress.current = current
          progress.after = await observe()
          progress.authority = { result: current.execution }
          progress.outbox = await AppRuntime.runPromise(Effect.gen(function* () {
            return yield* (yield* Database.Service).db.all("SELECT id,session_id,group_id,trigger_message_id,reply_message_id,status,attempts FROM im_reply_outbox")
          }))
          progress.retry = await request(`/api/v1/im/tasks/requests/${proposal.id}/accept`, {
            operationID: "explicit-http-accept", expectedRevision: proposal.revision,
          })
          progress.afterRetry = await observe()
        } else {
        const grant = await AppRuntime.runPromise(Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const config = yield* ServerAuth.Config
          const configured = yield* LocalTaskAuthority.configured(config)
          const witness = yield* LocalTaskAuthority.authenticatePassword(db, configured.runtime, config.username, configured.password)
          return yield* LocalTaskAuthority.provide({ runtime: configured.runtime, witness }, IMTaskAuthority.accept(db, {
            requestID: proposal.id, operationID: "explicit-fixture-accept", expectedRevision: proposal.revision,
          })).pipe(Effect.provide(LocalTaskAuth.layer))
        }).pipe(Effect.provide(ServerAuth.Config.defaultLayer)))
        progress.workID = grant.work_id
        await fs.writeFile(identityFile, JSON.stringify({ workID: grant.work_id, sessionID: grant.session_id }))
        const admitted = await AppRuntime.runPromise(Effect.gen(function* () {
          const events = yield* EventV2Bridge.Service
          return yield* WorkAdmission.admitOnly({ binding: grant.binding, auditedText: message.content, allowLoopbackHTTP: true })
            .pipe(Effect.provideService(EventV2.Service, events))
        }))
        progress.inputID = admitted.id
        progress.before = await observe()
        if (args.mode !== "prepare") {
          const running = AppRuntime.runPromise(Effect.gen(function* () {
            if (args.mode === "project-cold-known") {
              yield* (yield* EventV2Bridge.Service).listen((event) => Schema.is(SessionEvent.Tool.Success)(event) && event.data.sessionID === grant.session_id
                ? Effect.promise(() => fs.writeFile(path.join(directory, "known-read-committed"), "committed")).pipe(Effect.andThen(Effect.never))
                : Effect.void)
            }
            return yield* (yield* SessionExecution.Service).resume(SessionSchema.ID.make(grant.session_id))
          }).pipe(Effect.scoped, Effect.exit))
          if (args.mode === "count-revoked" || args.mode === "project-count-revoked") {
            const marker = path.join(directory, "count-observed")
            const started = Date.now()
            while (!(await Bun.file(marker).exists())) {
              if (Date.now() - started > 8_000) throw new Error("Actual counter request was not observed")
              await Bun.sleep(10)
            }
            await AppRuntime.runPromise(Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const config = yield* ServerAuth.Config
              const configured = yield* LocalTaskAuthority.configured(config)
              const witness = yield* LocalTaskAuthority.authenticatePassword(db, configured.runtime, config.username, configured.password)
              const current = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx)).pipe(Effect.provideService(LocalOperator.Runtime, configured.runtime))
              return yield* LocalTaskAuthority.provide({ runtime: configured.runtime, witness },
                LocalOperator.revoke(db, { operationID: "revoke-during-count", expectedRevision: current.revision }))
            }).pipe(Effect.provide(ServerAuth.Config.defaultLayer)))
            await fs.writeFile(path.join(directory, "count-release"), "revoked")
          }
          if (args.mode === "generation-cancel") {
            const started = Date.now()
            while (!(await Bun.file(path.join(directory, "generation-observed")).exists())) {
              if (Date.now() - started > 8_000) throw new Error("Actual generation request was not observed")
              await Bun.sleep(10)
            }
            await AppRuntime.runPromise(Effect.gen(function* () {
              yield* (yield* SessionExecution.Service).interrupt(SessionSchema.ID.make(grant.session_id))
            }))
          }
          const outcome = await running
          progress.execution = Exit.isSuccess(outcome) ? "completed" : Cause.pretty(outcome.cause)
          progress.executionCode = failureCode(outcome)
        }
        progress.after = await observe()
        if (args.mode.startsWith("generation-") || args.mode === "project-generation-partial" || args.mode === "project-write-unknown") {
          const retry = await AppRuntime.runPromise(Effect.gen(function* () {
            yield* (yield* SessionExecution.Service).resume(SessionSchema.ID.make(grant.session_id))
          }).pipe(Effect.exit))
          progress.retryCode = failureCode(retry)
          progress.afterRetry = await observe()
        }
        progress.authority = await AppRuntime.runPromise(Effect.gen(function* () {
          const found = yield* WorkAuthority.lookupSession((yield* Database.Service).db, grant.session_id)
          return found.kind === "bound" ? { control: found.work.control_state, result: found.work.outcome } : { kind: found.kind }
        }))
        }
      }
      await fs.writeFile(output, JSON.stringify(progress, null, 2))
    } catch (error) {
      progress.error = error instanceof Error ? error.stack : String(error)
      await fs.writeFile(output, JSON.stringify(progress, null, 2))
      process.exitCode = 1
    } finally {
      await listener.stop(true)
      await AppRuntime.dispose()
    }
  },
})

function failureCode(outcome: Exit.Exit<unknown, unknown>) {
  if (Exit.isSuccess(outcome)) return "success"
  const error = Cause.squash(outcome.cause)
  if (typeof error !== "object" || error === null) return "untyped"
  return "code" in error ? error.code : "_tag" in error ? error._tag : "untyped"
}
