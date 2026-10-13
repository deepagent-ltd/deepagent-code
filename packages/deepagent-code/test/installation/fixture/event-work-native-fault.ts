// Test CLI only. Source, HTTP mutations, Native seals, count and runner remain production services.
import fs from "node:fs/promises"
import { Cause, Effect, Exit, Schema } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { RequestExecutor } from "@deepagent-code/llm/route"
import { Config } from "@deepagent-code/core/config"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { Database } from "@deepagent-code/core/database/database"
import { AgentV2 } from "@deepagent-code/core/agent"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { AppRuntime } from "@/effect/app-runtime"
import { EventWorkRuntime } from "@/session/event-work-admission"
import { LocalAuthority } from "@/installation/local-authority"
import { ServerAuth } from "@/server/auth"
import { Server } from "@/server/server"
import { cmd } from "@/cli/cmd/cmd"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { AuthRuntime } from "@/im/auth-runtime"
import path from "node:path"

export const Fault = Schema.Literals([
  "count-unknown",
  "count-over",
  "count-revoked",
  "credential-change",
  "config-change",
  "source-pause",
  "operator-rotation",
  "generation-partial",
  "generation-usage-missing",
  "generation-usage-over",
])

const Input = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("transport-probe"), directory: Schema.String }),
  Schema.Struct({ mode: Schema.Literal("setup-source"), directory: Schema.String }),
  Schema.Struct({
    mode: Schema.Literals(["run", "cold"]),
    directory: Schema.String,
    sourceSessionID: Schema.String,
    fault: Schema.optional(Fault),
  }),
])

export const DebugCommand = cmd({
  command: "debug",
  handler: async () => {
    const descriptor = process.env.DAC_EVENT_WORK_FAULT_INPUT
    const output = process.env.DAC_EVENT_WORK_FAULT_RESULT
    if (!descriptor || !output) throw new Error("Private fault descriptor and result are required")
    const progress: Record<string, unknown> = { stage: "root", productionSource: true, availabilityOverride: false }
    const result = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Input))(
          yield* Effect.promise(() => fs.readFile(descriptor, "utf8")),
        )
        const sessions = yield* SessionV2.Service
        if (input.mode === "transport-probe") {
          const exercise = (layer: typeof RequestExecutor.defaultLayer | typeof RequestExecutor.builtinBunLayer) =>
            Effect.gen(function* () {
              const executor = yield* RequestExecutor.Service
              const results = yield* Effect.forEach(
                [
                  "https://api.openai.com/v1/responses",
                  "https://api.openai.com/v1/responses/input_tokens",
                  "https://api.deepseek.com/responses",
                  "https://api.openai.com/v1/unexpected",
                  "https://api.openai.com.evil.invalid/v1/responses",
                  "https://fixture-invalid.invalid/responses",
                  "http://api.deepseek.com/responses",
                ],
                (url) =>
                  Effect.gen(function* () {
                    const request = HttpClientRequest.post(url).pipe(
                      HttpClientRequest.setHeader("authorization", "Bearer fixture-native-key"),
                      HttpClientRequest.bodyText(JSON.stringify({ transport_probe: true }), "application/json"),
                    )
                    const result = yield* executor.execute(request).pipe(
                      Effect.flatMap((response) => response.text),
                      Effect.exit,
                    )
                    return {
                      url,
                      accepted: Exit.isSuccess(result),
                      ...(Exit.isFailure(result) ? { failure: Cause.pretty(result.cause) } : {}),
                    }
                  }),
              )
              return results
            }).pipe(
              Effect.provide(layer),
              Effect.provideService(RequestExecutor.CurrentRetryLimit, 0),
              Effect.provideService(RequestExecutor.CurrentRedirectPolicy, "manual"),
              Effect.provideService(RequestExecutor.CurrentRequestSeal, { seal: () => Effect.void }),
            )
          progress.ordinary = yield* exercise(RequestExecutor.defaultLayer)
          progress.native = yield* exercise(RequestExecutor.builtinBunLayer)
          progress.stage = "ordinary-native-physical-transport-probed-no-work-authority"
          return
        }
        if (input.mode === "setup-source") {
          const source = yield* sessions.create({
            title: "Offline ordinary source for current Native fault boundary",
            agent: AgentV2.ID.make("auto"),
            model: { providerID: ProviderV2.ID.make("openai"), id: ModelV2.ID.make("gpt-4.1-2025-04-14") },
            location: { directory: AbsolutePath.make(input.directory) },
            permissions: [{ action: "*", resource: "*", effect: "deny" }],
          })
          progress.stage = "ordinary-source-created-no-provider"
          progress.sourceSessionID = source.id
          return
        }
        const db = (yield* Database.Service).db
        const runtime = yield* EventWorkRuntime.make
        if (input.mode === "cold") {
          const entries = yield* Effect.gen(function* () {
            return yield* (yield* Config.Service).entries()
          }).pipe(Effect.provide((yield* LocationServiceMap).get({ directory: AbsolutePath.make(input.directory) })))
          progress.currentModelDisabled =
            Config.latest(entries, "providers")?.openai?.models?.["gpt-4.1-2025-04-14"]?.disabled === true
          progress.currentCredentialChanged = process.env.DAC_FIXTURE_NATIVE_KEY === "changed-fixture-native-key"
          progress.before = yield* census(db)
          yield* runtime.reconcile
          yield* Effect.sleep(500)
          progress.after = yield* census(db)
          progress.stage = "cold-original-reconcile-no-replay"
          return
        }
        const config = yield* ServerAuth.Config
        const configured = yield* LocalAuthority.configured(config)
        const witness = yield* LocalAuthority.authenticatePassword(
          db,
          configured.runtime,
          config.username,
          configured.password,
        )
        const listener = yield* Effect.acquireRelease(
          Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })),
          (listener) => Effect.promise(() => listener.stop(true)),
        )
        const control = (body: Record<string, unknown>) =>
          Effect.tryPromise({
            try: async () => {
              const route = new URL("/api/v1/event-work/rules/control", listener.url)
              route.searchParams.set("directory", input.directory)
              const response = await fetch(route, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  authorization: `Basic ${Buffer.from(`${config.username}:${configured.password}`).toString("base64")}`,
                },
                body: JSON.stringify({
                  sourceSessionID: input.sourceSessionID,
                  ruleID: "current-native-fault",
                  ...body,
                }),
              })
              const value: unknown = await response.json()
              if (response.status !== 200)
                throw new Error(`Original public rule control refused ${response.status}: ${JSON.stringify(value)}`)
            },
            catch: (error) => (error instanceof Error ? error : new Error("Original public control failed")),
          })
        progress.stage = "public-rule-create-enable"
        yield* control({
          action: "create",
          requestID: "create-current",
          expectedRevision: 0,
          originID: "ordinary-terminal",
          instruction: "Read guard.test.ts within the approved scope and summarize it.",
          expiresAt: Date.now() + 180_000,
        })
        yield* control({ action: "enable", requestID: "enable-current", expectedRevision: 1 })
        progress.stage = "ordinary-source-provider"
        yield* sessions.prompt({
          sessionID: SessionSchema.ID.make(input.sourceSessionID),
          prompt: Prompt.fromUserMessage({ text: "Return the exact text ordinary source settled." }),
          delivery: "queue",
          resume: false,
        })
        yield* sessions.resume(SessionSchema.ID.make(input.sourceSessionID))
        progress.stage = "original-event-reconcile"
        const deadline = Date.now() + 30_000
        const mutation = { performed: false }
        while (Date.now() < deadline) {
          yield* runtime.reconcile
          const current = yield* census(db)
          if (
            !mutation.performed &&
            current.counts.some((row) => row.state === "sending") &&
            input.fault &&
            ["count-revoked", "credential-change", "config-change", "source-pause", "operator-rotation"].includes(
              input.fault,
            )
          ) {
            if (input.fault === "credential-change") process.env.DAC_FIXTURE_NATIVE_KEY = "changed-fixture-native-key"
            if (input.fault === "config-change")
              yield* Effect.promise(async () => {
                const config = Schema.decodeUnknownSync(Config.Info)(
                  await Bun.file(path.join(input.directory, "deepagent-code.json")).json(),
                )
                await fs.writeFile(
                  path.join(input.directory, "deepagent-code.json"),
                  JSON.stringify({
                    ...config,
                    providers: {
                      ...config.providers,
                      openai: {
                        ...config.providers?.openai,
                        models: {
                          ...config.providers?.openai?.models,
                          "gpt-4.1-2025-04-14": {
                            ...config.providers?.openai?.models?.["gpt-4.1-2025-04-14"],
                            disabled: true,
                          },
                        },
                      },
                    },
                  }),
                )
              })
            if (input.fault === "source-pause")
              yield* control({ action: "pause", requestID: "pause-during-count", expectedRevision: 2 })
            if (input.fault === "count-revoked" || input.fault === "operator-rotation") {
              const actor = yield* db
                .transaction((tx) => LocalOperator.requireCurrent(tx))
                .pipe(Effect.provideService(LocalOperator.Runtime, configured.runtime))
              yield* LocalAuthority.provide(
                { runtime: configured.runtime, witness },
                input.fault === "count-revoked"
                  ? LocalOperator.revoke(db, { operationID: "revoke-during-count", expectedRevision: actor.revision })
                  : LocalOperator.rotate(db, {
                      operationID: "rotate-during-count",
                      expectedRevision: actor.revision,
                      username: config.username,
                      credentialVerifier: yield* Effect.promise(() =>
                        AuthRuntime.hash("changed-fixture-operator-password"),
                      ),
                    }),
              )
            }
            mutation.performed = true
            progress.mutation = input.fault
            yield* Effect.promise(() => fs.writeFile(path.join(input.directory, "count-release"), input.fault!))
          }
          if (current.counts.some((row) => row.state !== "sending" && row.state !== "prepared")) {
            if (current.work[0])
              yield* (yield* SessionExecution.Service)
                .awaitIdle(SessionSchema.ID.make(current.work[0].session_id))
                .pipe(Effect.exit)
            progress.after = yield* census(db)
            progress.stage = "current-server-rule-fault-settled"
            return
          }
          yield* Effect.sleep(50)
        }
        progress.after = yield* census(db)
        throw new Error("The original current source did not reach the Native count refusal within its bound")
      }).pipe(Effect.provide(ServerAuth.Config.defaultLayer), Effect.scoped, Effect.exit),
    )
    if (Exit.isFailure(result)) {
      progress.error = Cause.pretty(result.cause)
      process.exitCode = 1
    }
    await AppRuntime.dispose()
    await fs.writeFile(output, JSON.stringify(progress, null, 2), { mode: 0o600 })
  },
})

function census(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    return {
      receipts: yield* db.all<{ receipt_id: string; phase: string }>(
        "SELECT receipt_id,phase FROM event_work_receipt ORDER BY receipt_id",
      ),
      work: yield* db.all<{
        work_id: string
        session_id: string
        source_kind: string
        authority_id: string
        outcome: string
        admission_state: string
      }>(
        "SELECT work_id,session_id,source_kind,authority_id,outcome,admission_state FROM work_execution ORDER BY work_id",
      ),
      counts: yield* db.all<{ state: string; revision: number; record: string }>(
        "SELECT state,revision,record FROM work_count_acquisition ORDER BY acquisition_id",
      ),
      dispatches: yield* db.all<{ state: string; reserved_total_tokens: number; charged_tokens: number }>(
        "SELECT state,reserved_total_tokens,charged_tokens FROM work_dispatch_reservation ORDER BY reservation_id",
      ),
      providers: yield* db.all<{ session_id: string; state: string }>(
        "SELECT session_id,state FROM session_provider_attempt ORDER BY attempt_id",
      ),
      tools: yield* db.all<{ state: string }>("SELECT state FROM session_v2_tool_effect ORDER BY effect_id"),
    }
  })
}
