// Compiled signed CLI command only. Enrollment/approval are normal CLI commands in prior
// processes. This process uses the actual Root, authenticated password witness and sole EV consumer.
import { Cause, Effect, Exit, Schema } from "effect"
import fs from "node:fs/promises"
import { Database } from "@deepagent-code/core/database/database"
import { EventValidation } from "@deepagent-code/core/deepagent/event-validation"
import { EventValidationSchema } from "@deepagent-code/core/deepagent/event-validation.schema"
import { EventInvestigation } from "@deepagent-code/core/deepagent/event-investigation"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { WorkExecutionProfile } from "@deepagent-code/core/session/work-execution-profile"
import { EventInvestigationHost } from "@/deepagent/event-investigation"
import { AppRuntime } from "@/effect/app-runtime"
import { LocalAuthority } from "@/installation/local-authority"
import { ServerAuth } from "@/server/auth"
import { Server } from "@/server/server"
import { InvestigationCaptured } from "@/server/routes/instance/httpapi/groups/event-investigation"
import { cmd } from "@/cli/cmd/cmd"

export const DebugCommand = cmd({
  command: "debug",
  handler: async () => {
    const output = process.env.DAC_EVENT_NATIVE_RESULT
    if (!output) throw new Error("A private diagnostic result file is required")
    const progress: Record<string, unknown> = { scope: "signed-actual-root-local-https-test-transport", stage: "root" }
    const outcome = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const config = yield* ServerAuth.Config
        const configured = yield* LocalAuthority.configured(config)
        yield* LocalAuthority.authenticatePassword(db, configured.runtime, config.username, configured.password)
        // Server.listen adopts this already-built AppRuntime memo map. TCP socket facts
        // are required for the real mutation witness; fetch-only adapters fail closed.
        const listener = yield* Effect.acquireRelease(
          Effect.promise(() =>
            Server.listen({ hostname: "127.0.0.1", port: Number(process.env.DAC_EVENT_NATIVE_HTTP_PORT) }),
          ),
          (listener) => Effect.promise(() => listener.stop(true)),
        )
        const request = (route: string, body: unknown) =>
          Effect.tryPromise({
            try: async () => {
              const response = await fetch(new URL(route, listener.url), {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  authorization: `Basic ${Buffer.from(`${config.username}:${configured.password}`).toString("base64")}`,
                },
                body: JSON.stringify(body),
              })
              const value: unknown = await response.json()
              if (response.status !== 200)
                throw new Error(`Actual HTTP ${route} refused: ${response.status} ${JSON.stringify(value)}`)
              return value
            },
            catch: (error) => (error instanceof Error ? error : new Error("Actual HTTP request failed")),
          })
        const operator = yield* db
          .transaction((tx) => LocalOperator.requireCurrent(tx))
          .pipe(Effect.provideService(LocalOperator.Runtime, configured.runtime))
        const target = operator.policy.targets.find((entry) => entry.id === "validation")
        if (!target || !("version" in target.target) || !target.target.toolPolicy.commandRecipes?.[0])
          throw new Error("The actual enrolled validation recipe is unavailable")
        const configuration = Schema.decodeUnknownSync(EventValidationSchema.Configuration)({
          profile: "project_validation_v1",
          scope: {
            instanceID: operator.instance_id,
            workspaceID: null,
            securityNamespaceID: target.target.scope.securityNamespaceID,
            namespaceBindingHash: target.namespaceBindingHash,
            locationKey: target.locationKey,
            projectScopeKey: target.target.scope.projectScopeKey,
            projectID: target.target.projectScope.projectID,
            canonicalRoot: target.target.location.directory,
            rootIdentity: target.target.projectScope.rootIdentity,
          },
          kind: "test",
          recipe: target.target.toolPolicy.commandRecipes[0],
          parameters: [],
          helperHash: target.target.projectScope.helperHash,
          watch: ["guard.test.ts"],
          recipient: "local_status",
          maxRuns: 1,
          expiresAt: Date.now() + 180000,
          investigation: "disabled",
          autoFix: false,
        })
        const investigation = yield* EventInvestigationHost.Service
        progress.stage = "configure"
        yield* request("/api/v1/event-validation/rules/configure", {
          ruleID: "actual-investigate-rule",
          requestID: "configure-once",
          expectedRevision: 0,
          configuration,
        }).pipe(
          Effect.tapError(() =>
            investigation.postRuleControl("actual-investigate-rule").pipe(
              Effect.provideService(LocalOperator.Runtime, configured.runtime),
              Effect.exit,
              Effect.tap((exit) =>
                Effect.sync(() => {
                  progress.postControlDiagnostic = Exit.isFailure(exit)
                    ? Cause.pretty(exit.cause)
                    : "actual empty revoked page read"
                }),
              ),
            ),
          ),
        )
        progress.stage = "grant-capture"
        const expiresAt = Date.now() + 120000
        const capture = yield* Schema.decodeUnknownEffect(InvestigationCaptured)(
          yield* request("/api/v1/event-investigation/capture", {
            ruleID: "actual-investigate-rule",
            targetID: "investigation",
            expiresAt,
          }),
        )
        progress.stage = "grant-enable"
        yield* request("/api/v1/event-investigation/control", {
          ruleID: "actual-investigate-rule",
          requestID: "grant-once",
          operation: "enable",
          expectedEpoch: 0,
          expectedOperatorRevision: operator.revision,
          targetID: "investigation",
          expiresAt,
          captureID: capture.captureID,
        })
        progress.before = yield* census(db)
        progress.stage = "actual-validation-enable"
        yield* request("/api/v1/event-validation/rules/actual-investigate-rule/control", {
          requestID: "enable-once",
          expectedRevision: 1,
          action: "enable",
        })
        const deadline = Date.now() + 45000
        const proof = (yield* WorkExecutionProfile.Services).leafProof
        const verified = { done: false }
        while (Date.now() < deadline) {
          const [work] = yield* db.all<{ outcome: string }>("SELECT outcome FROM work_execution")
          if (work && work.outcome !== "pending") break
          if (
            !verified.done &&
            process.env.DAC_EVENT_NATIVE_READ_READY &&
            (yield* Effect.promise(() => Bun.file(process.env.DAC_EVENT_NATIVE_READ_READY!).exists()))
          ) {
            const reads = yield* db.all<{ effect_id: string }>(
              "SELECT effect_id FROM session_v2_tool_effect WHERE tool_name='read' AND state='settled' AND error_code IS NULL",
            )
            if (!proof || reads.length !== 1 || !process.env.DAC_EVENT_NATIVE_READ_VERIFIED)
              throw new Error("The actual same-root native proof reader is unavailable")
            progress.knownReads = yield* Effect.forEach(reads, (row) => proof.verify(row.effect_id))
            yield* Effect.promise(() =>
              fs.writeFile(process.env.DAC_EVENT_NATIVE_READ_VERIFIED!, "actual read verified", { mode: 0o600 }),
            )
            verified.done = true
          }
          const failed = yield* db.get(
            "SELECT receipt_id FROM session_v2_provider_turn_receipt WHERE state='failed' LIMIT 1",
          )
          if (failed) break
          yield* Effect.sleep(50)
        }
        progress.after = yield* census(db)
        progress.rule = yield* EventValidation.getRule(db, "actual-investigate-rule")
        progress.runs = yield* EventValidation.history(db, "actual-investigate-rule")
        const [receipt] = yield* db.all<{ receipt_id: string }>(
          "SELECT receipt_id FROM event_validation_investigation_receipt",
        )
        if (receipt) progress.receipt = yield* EventInvestigation.get(db, receipt.receipt_id)
        // Diagnostic re-observation creates no receipt/Work/provider when the fresh hook did
        // not admit. It exposes the genuine Native refusal without manufacturing a success.
        if (!receipt) {
          const rule = yield* EventValidation.getRule(db, "actual-investigate-rule")
          const run = rule?.currentRunID ? yield* EventValidation.getRun(db, rule.currentRunID) : undefined
          if (rule && run && rule.investigationAuthority?.state === "enabled") {
            const observed = yield* investigation.native
              .observeFailure({ rule, run, grant: rule.investigationAuthority.grant })
              .pipe(Effect.exit)
            progress.nativeFailureDiagnostic = Exit.isFailure(observed)
              ? Cause.pretty(observed.cause)
              : "opaque capture observed"
          }
        }
        progress.activeSessions = [...(yield* (yield* SessionExecution.Service).active)]
        progress.stage = "observed"
      }).pipe(Effect.provide(ServerAuth.Config.defaultLayer), Effect.scoped, Effect.exit),
    )
    if (Exit.isFailure(outcome)) {
      progress.error = Cause.pretty(outcome.cause)
      process.exitCode = 1
    }
    await fs.writeFile(output, JSON.stringify(progress, null, 2), { mode: 0o600 })
    await AppRuntime.dispose()
  },
})

function census(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    return {
      receipts: yield* db.all(
        "SELECT receipt_id,work_id,session_id,input_id FROM event_validation_investigation_receipt",
      ),
      work: yield* db.all("SELECT work_id,admission_state,control_state,outcome FROM work_execution"),
      sessions: yield* db.all("SELECT id,execution_claim_token FROM session"),
      inputs: yield* db.all("SELECT id,session_id,promoted_seq FROM session_input"),
      counts: yield* db.all("SELECT state,record FROM work_count_acquisition"),
      dispatches: yield* db.all("SELECT state,reserved_total_tokens,charged_tokens FROM work_dispatch_reservation"),
      providers: yield* db.all("SELECT state,outcome_hash,error_code FROM session_v2_provider_turn_receipt"),
      tools: yield* db.all("SELECT state,effect_kind,known_read_proof FROM session_v2_tool_effect"),
    }
  })
}
