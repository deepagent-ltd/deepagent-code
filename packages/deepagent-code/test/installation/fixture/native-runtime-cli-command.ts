// Build-time substitution for the debug command ONLY. The signed test inventory names this
// file and the replaced command. Production builds have no environment switch to install it.
import { createHash } from "node:crypto"
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Scope } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LLM, LLMClient, Message, Model } from "@deepagent-code/llm"
import { Auth, RequestExecutor } from "@deepagent-code/llm/route"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { SessionRunnerModel } from "@deepagent-code/core/session/runner/model"
import { SessionV2 } from "@deepagent-code/core/session"
import { AbsolutePath } from "@deepagent-code/core/schema"
import type { Capture } from "@/installation/provider-credential-binding"
import { NativeRuntime } from "@/installation/native-runtime"
import { NativeBootstrap } from "@/runtime/native-bootstrap"
import { LocalTaskAuthority } from "@/im/local-task-authority"
import { AppRuntime } from "@/effect/app-runtime"
import { cmd } from "@/cli/cmd/cmd"

// Intentional signed-test mutations before index.ts calls install(). No product environment hook.
if (process.argv.at(-1) === "early-global")
  globalThis.fetch = Object.assign(() => Promise.reject(new Error("fixture early fetch")), {
    preconnect: globalThis.fetch.preconnect,
  })
if (process.argv.at(-1) === "early-env") process.env.HTTPS_PROXY = "http://127.0.0.1:1"

export const DebugCommand = cmd({
  command: "debug <mode>",
  builder: (yargs) => yargs.positional("mode", { type: "string", demandOption: true }),
  handler: async (args) => {
    const observations: { bodyHash: string; wireHash: string; bodyLength: number; method?: string; url?: string }[] = []
    const progress: Record<string, unknown> = {}
    const retained: {
      runtime?: NativeRuntime.Interface
      handle?: NativeRuntime.ApprovedRuntime
      scope?: Scope.Closeable
    } = {}
    const result = await AppRuntime.runPromise(
      Effect.gen(function* () {
        if (args.mode.startsWith("historical-")) {
          const { Database } = yield* Effect.promise(() => import("@deepagent-code/core/database/database"))
          const { WorkRouteApproval } = yield* Effect.promise(
            () => import("@deepagent-code/core/session/work-route-approval"),
          )
          const { CanonicalJson } = yield* Effect.promise(() => import("@deepagent-code/core/util/canonical-json"))
          const { ProviderCredentialBinding } = yield* Effect.promise(
            () => import("@/installation/provider-credential-binding"),
          )
          const { ServerAuth } = yield* Effect.promise(() => import("@/server/auth"))
          const { command } = yield* Effect.promise(() => import("@/cli/cmd/operator"))
          const { OfflineNativeRouteApproval } = yield* Effect.promise(
            () => import("@/installation/native-route-approval"),
          )
          const captureFactory = yield* Effect.serviceOption(OfflineNativeRouteApproval.CaptureFactory)
          const { sql } = yield* Effect.promise(() => import("drizzle-orm"))
          const { LocationIdentity } = yield* Effect.promise(
            () => import("@deepagent-code/core/context-federation/identity"),
          )
          const { FSUtil } = yield* Effect.promise(() => import("@deepagent-code/core/fs-util"))
          const database = yield* Database.Service
          return yield* Effect.gen(function* () {
            const credentials = yield* ProviderCredentialBinding.Service
            const rows = yield* database.db.all<{
              approval_id: string
              record: string
              record_hash: string
              record_mac: string
            }>("SELECT approval_id,record,record_hash,record_mac FROM work_route_approval")
            const stored = rows[0]
            if (!stored) return yield* Effect.die("missing original approval")
            const original = yield* WorkRouteApproval.get(database.db, stored.approval_id).pipe(
              Effect.provideService(WorkRouteApproval.Authority, credentials.authority),
            )
            if (!original) return yield* Effect.die("missing authenticated approval")
            const revert = database.db
              .run(
                sql`UPDATE work_route_approval SET record=${stored.record},record_hash=${stored.record_hash},record_mac=${stored.record_mac}`,
              )
              .pipe(Effect.asVoid, Effect.orDie)
            if (args.mode === "historical-mac-tamper")
              yield* database.db.run("UPDATE work_route_approval SET record_mac='" + "0".repeat(64) + "'")
            if (args.mode === "historical-missing-identity") {
              const record = {
                ...original,
                commands: original.commands.map((entry) => {
                  if (!("identityHash" in entry)) return entry
                  const { identityHash, ...rest } = entry
                  return rest
                }),
              }
              const encoded = CanonicalJson.stringify(record)
              yield* database.db.run(
                sql`UPDATE work_route_approval SET record=${encoded},record_hash=${WorkRouteApproval.hash(record)}`,
              )
            }
            if (args.mode.startsWith("historical-legacy")) {
              const record = {
                ...original,
                version: 1 as const,
                commands: original.commands.map((entry) => ({
                  requestID: entry.requestID,
                  requestHash: entry.requestHash,
                  action: entry.action,
                  expectedRevision: entry.expectedRevision,
                  receipt: entry.receipt,
                })),
              }
              const encoded = CanonicalJson.stringify(record)
              const mac = yield* credentials.authority.authenticate(record)
              yield* database.db.run(
                sql`UPDATE work_route_approval SET record=${encoded},record_hash=${WorkRouteApproval.hash(record)},record_mac=${mac}`,
              )
            }
            const snapshot = Effect.gen(function* () {
              const names = yield* database.db.all<{ name: string }>(
                "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'session%' OR name LIKE 'event%' OR name LIKE 'work_%' OR name LIKE 'local_operator%') ORDER BY name",
              )
              const values: Record<string, unknown> = {}
              for (const row of names) values[row.name] = yield* database.db.all(`SELECT * FROM "${row.name}"`)
              return WorkRouteApproval.hash(values)
            })
            return yield* Effect.gen(function* () {
              const before = yield* snapshot
              const now = Date.now
              if (["historical-at-expiry", "historical-expired", "historical-revoked-expired"].includes(args.mode))
                Date.now = () => original.evidence.expiresAt + (args.mode === "historical-at-expiry" ? 0 : 1)
              const revoke = args.mode === "historical-revoke" || args.mode === "historical-revoke-retry"
              const query = args.mode === "historical-query" || args.mode === "historical-legacy-query"
              const result = yield* command({
                action: query ? "route-history" : revoke ? "revoke-route" : "approve-route",
                operationID: revoke
                  ? "historical-revoke"
                  : args.mode === "historical-new-unavailable"
                    ? "new-without-factory"
                    : "approval",
                targetID: "review",
                expectedRevision: revoke ? 2 : args.mode === "historical-args-revision" ? 2 : 1,
                expectedRouteRevision: revoke ? 1 : 0,
                ...(!revoke && !query
                  ? {
                      snapshot: args.mode === "historical-args-snapshot" ? "changed" : "snapshot-1",
                      expiresAt: original.evidence.expiresAt + (args.mode === "historical-args-expiry" ? 1 : 0),
                    }
                  : {}),
              }).pipe(
                Effect.provideService(ServerAuth.Config, {
                  username: "fixture",
                  password: Option.some("fixture-offline-password"),
                }),
                Effect.provide(
                  LocationIdentity.layer.pipe(
                    Layer.provide(Layer.succeed(Database.Service, database)),
                    Layer.provide(FSUtil.defaultLayer),
                  ),
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    Date.now = now
                  }),
                ),
                Effect.exit,
              )
              const after = yield* snapshot
              const error = Exit.isFailure(result) ? Cause.squash(result.cause) : undefined
              return {
                code:
                  error && typeof error === "object" && "code" in error
                    ? error.code
                    : Exit.isSuccess(result)
                      ? "success"
                      : String(error),
                value: Exit.isSuccess(result) ? result.value : null,
                rowsUnchanged: before === after,
                originalReceipt: original.commands[0]!.receipt,
                noCaptureFactoryInstalled: Option.isNone(captureFactory),
              }
            }).pipe(
              Effect.ensuring(
                args.mode.includes("legacy") || args.mode.includes("tamper") || args.mode.includes("missing-identity")
                  ? revert
                  : Effect.void,
              ),
            )
          }).pipe(Effect.provide(ProviderCredentialBinding.layer))
        }
        const directory = AbsolutePath.make(process.cwd())
        const session = yield* (yield* SessionV2.Service).create({
          location: { directory },
          title: "Native construction fixture",
        })
        const locations = yield* LocationServiceMap
        const runtime = yield* NativeRuntime.Service
        return yield* Effect.gen(function* () {
          const client = yield* LLMClient.Service
          const resolved = yield* (yield* SessionRunnerModel.Service).resolve(session)
          progress.resolved = {
            bootstrap: NativeBootstrap.describe(),
            nativeClient: LLMClient.nativeDescription(client),
            frozenClient: Object.isFrozen(client),
            actualResolution: !!SessionRunnerModel.construction(resolved),
            sameClient: SessionRunnerModel.construction(resolved)?.client === client,
            auth: Auth.construction(resolved.model.route.auth),
            protocol: resolved.model.route.protocol,
          }
          const handle = yield* runtime.approve(args.mode === "copy-resolved" ? { ...resolved } : resolved)
          const description = yield* runtime.describe(handle)
          if (args.mode.startsWith("privacy")) {
            const keys = [
              "HTTP_PROXY",
              "http_proxy",
              "HTTPS_PROXY",
              "https_proxy",
              "ALL_PROXY",
              "all_proxy",
              "NO_PROXY",
              "no_proxy",
              "NODE_TLS_REJECT_UNAUTHORIZED",
              "NODE_EXTRA_CA_CERTS",
              "SSL_CERT_FILE",
              "SSL_CERT_DIR",
              "BUN_CA_FILE",
              "NODE_OPTIONS",
              "BUN_OPTIONS",
            ]
            const candidates = ["0000", "1234", "9999"]
            // A low-entropy guessing attacker knows all non-secret fixture configuration. These
            // deliberately reproduce the prior public SHA preimage, not a production HMAC oracle.
            const environment = (password: string) =>
              keys.map((key) => [
                key,
                key === "HTTP_PROXY" ? `http://fixture:${password}@127.0.0.1:1` : process.env[key] || null,
              ])
            const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
            const bootstrapGuessMatch = candidates.some(
              (password) =>
                digest({
                  environment: environment(password),
                  execArgv: process.execArgv,
                  runtime: process.versions.bun ?? null,
                }) === description.bootstrapConfigurationHash,
            )
            const executorGuessMatch = candidates.some(
              (password) => digest(environment(password)) === description.executorConfigurationHash,
            )
            const modelGuessMatch = candidates.some(
              (password) =>
                digest({
                  id: resolved.model.id,
                  provider: resolved.model.provider,
                  model: Object.fromEntries(Object.entries(resolved.model).filter(([key]) => key !== "route")),
                  info: {
                    ...resolved.info,
                    request: { ...resolved.info?.request, body: { ...resolved.info?.request.body, apiKey: password } },
                  },
                  providerInfo: resolved.provider,
                }) === description.sourceHash,
            )
            const fresh = yield* Effect.gen(function* () {
              const other = yield* RequestExecutor.Service
              return RequestExecutor.builtinDescription(other)?.configurationHash
            }).pipe(Effect.provide(RequestExecutor.builtinBunLayer.pipe(Layer.fresh)))
            const second = yield* (yield* SessionRunnerModel.Service).resolve(session)
            return {
              bootstrapGuessMatch,
              executorGuessMatch,
              modelGuessMatch,
              staticCredentialPresent: resolved.info?.request.body.apiKey === "1234",
              sameObjectStable: JSON.stringify(yield* runtime.describe(handle)) === JSON.stringify(description),
              freshExecutorDifferent: fresh !== description.executorConfigurationHash,
              freshResolutionDifferent: SessionRunnerModel.construction(second)?.sourceHash !== description.sourceHash,
              fingerprints: [
                description.bootstrapConfigurationHash,
                description.executorConfigurationHash,
                description.sourceHash,
              ],
            }
          }
          if (args.mode === "root-close") {
            retained.scope = yield* Scope.make()
            retained.handle = yield* runtime.approve(resolved).pipe(Effect.provideService(Scope.Scope, retained.scope))
            retained.runtime = runtime
            return { live: runtime.live() }
          }
          if (args.mode === "copy-handle") yield* runtime.describe({ ...handle })
          if (args.mode === "scope") {
            const scope = yield* Scope.make()
            const other = yield* runtime.approve(resolved).pipe(Effect.provideService(Scope.Scope, scope))
            yield* Scope.close(scope, Exit.void)
            return { closed: (yield* runtime.describe(other).pipe(Effect.exit))._tag, live: runtime.live() }
          }
          if (args.mode === "capacity") {
            const scope = yield* Scope.make()
            for (const index of Array.from({ length: 31 }, (_, index) => index)) {
              yield* runtime.approve(resolved).pipe(Effect.provideService(Scope.Scope, scope))
              progress.capacity = index + 2
            }
            const full = yield* runtime.approve(resolved).pipe(Effect.exit)
            const live = runtime.live()
            yield* Scope.close(scope, Exit.void)
            return { full: full._tag, live, after: runtime.live() }
          }
          if (args.mode === "foreign-root") {
            return yield* Effect.gen(function* () {
              const foreign = yield* NativeRuntime.Service
              return {
                handle: (yield* foreign.describe(handle).pipe(Effect.exit))._tag,
                resolved: (yield* foreign.approve(resolved).pipe(Effect.exit))._tag,
              }
            }).pipe(
              Effect.provide(
                NativeRuntime.layer.pipe(
                  Layer.provide(NativeRuntime.clientLayer),
                  Layer.provide(
                    Layer.succeed(LLMClient.Middleware, () => ({ prepare: (next) => next, stream: (next) => next })),
                  ),
                  Layer.fresh,
                ),
              ),
            )
          }
          if (args.mode === "auth-replace") Reflect.set(resolved.model.route, "auth", Auth.none)
          if (args.mode === "auth-function")
            Reflect.set(resolved.model.route.auth, "apply", () => Effect.die("replaced auth"))
          if (args.mode === "auth-rotate" || args.mode === "auth-provider-rotate")
            process.env.DAC_FIXTURE_NATIVE_KEY = "fixture-rotated-key"
          if (args.mode === "env-drift") process.env.HTTPS_PROXY = "http://127.0.0.1:1"
          if (args.mode === "global-drift")
            globalThis.fetch = Object.assign(() => Promise.reject(new Error("fixture late fetch")), {
              preconnect: globalThis.fetch.preconnect,
            })
          const request = LLM.request({
            model:
              args.mode === "model-copy" ? Model.update(resolved.model, { id: resolved.model.id }) : resolved.model,
            system: "Static fixture instructions",
            messages: [
              Message.user([
                { type: "text", text: args.mode === "partial-write" ? "x".repeat(1_048_576) : "中文与原生 PNG" },
                {
                  type: "media",
                  mediaType: "image/png",
                  data: new Uint8Array(
                    Buffer.from(
                      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=",
                      "base64",
                    ),
                  ),
                },
              ]),
            ],
            generation: { maxTokens: 16 },
            http: {
              body: { store: false },
              headers:
                args.mode.startsWith("capture") || args.mode.startsWith("approval")
                  ? {}
                  : { "x-native-fixture": "final-header" },
            },
          })
          if (args.mode.startsWith("approval")) {
            const { Database } = yield* Effect.promise(() => import("@deepagent-code/core/database/database"))
            const { LocalOperator } = yield* Effect.promise(() => import("@deepagent-code/core/im/local-operator"))
            const { WorkRouteApproval } = yield* Effect.promise(
              () => import("@deepagent-code/core/session/work-route-approval"),
            )
            const { WorkAuthorityPolicy } = yield* Effect.promise(
              () => import("@deepagent-code/core/session/work-authority-policy"),
            )
            const { LocationIdentity } = yield* Effect.promise(
              () => import("@deepagent-code/core/context-federation/identity"),
            )
            const { FSUtil } = yield* Effect.promise(() => import("@deepagent-code/core/fs-util"))
            const { Config } = yield* Effect.promise(() => import("@deepagent-code/core/config"))
            const { LocalOperatorPolicy } = yield* Effect.promise(() => import("@/im/local-operator-policy"))
            const { ProviderCredentialBinding } = yield* Effect.promise(
              () => import("@/installation/provider-credential-binding"),
            )
            const { OfflineNativeRouteApproval } = yield* Effect.promise(
              () => import("@/installation/native-route-approval"),
            )
            const database = yield* Database.Service
            const installation = yield* LocalTaskAuthority.initializeInstallation()
            const identity = LocalTaskAuthority.binding(installation, "fixture", "fixture-offline-password")
            const approvalID = `route_${WorkRouteApproval.hash([installation.instanceID, "fixture-operator", "review"])}`
            return yield* Effect.gen(function* () {
              if (args.mode !== "approval-reopen") {
                const policy = yield* LocalOperatorPolicy.resolve(
                  {
                    version: 1,
                    targets: [
                      {
                        id: "review",
                        directory,
                        agentID: "auto",
                        providerID: "fixture",
                        modelID: "snapshot-1",
                        budget: WorkAuthorityPolicy.TEXT_ONLY_PROFILE.budget,
                      },
                    ],
                  },
                  "fixture-operator",
                ).pipe(
                  Effect.provide(
                    LocationIdentity.layer.pipe(
                      Layer.provide(Layer.succeed(Database.Service, database)),
                      Layer.provide(FSUtil.defaultLayer),
                    ),
                  ),
                )
                const verifier = yield* Effect.promise(() =>
                  Bun.password.hash("fixture-offline-password", { algorithm: "argon2id" }),
                )
                yield* LocalOperator.enroll(database.db, {
                  operationID: "enroll",
                  operatorID: "fixture-operator",
                  username: "fixture",
                  credentialVerifier: verifier,
                  policy,
                })
              }
              const credentials = yield* ProviderCredentialBinding.Service
              const read = () =>
                WorkRouteApproval.get(database.db, approvalID).pipe(
                  Effect.provideService(WorkRouteApproval.Authority, credentials.authority),
                )
              const previous = yield* read()
              const witness = yield* LocalTaskAuthority.authenticatePassword(
                database.db,
                identity,
                "fixture",
                "fixture-offline-password",
              )
              const actualConfig = yield* Config.Service
              if (args.mode === "approval-source-drift") {
                const raw = Config.latest(yield* actualConfig.entries(), "providers")?.fixture
                if (!raw?.api) return yield* Effect.die("missing fixture config")
                Reflect.set(raw.api, "url", "https://127.0.0.1:2/changed")
              }
              const receipt = yield* OfflineNativeRouteApproval.approve({
                targetID: "review",
                snapshot: "snapshot-1",
                expiresAt: previous?.evidence.expiresAt ?? Date.now() + 60_000,
                requestID: "approval",
                expectedRevision: 0,
                expectedOperatorRevision: 1,
              }).pipe(
                Effect.provideService(LocalOperator.Mutation, witness),
                Effect.provideService(OfflineNativeRouteApproval.CaptureFactory, {
                  capture: (input) =>
                    Effect.gen(function* () {
                      const captured: { value?: Capture } = {}
                      const scope = yield* Effect.scope
                      const seal = yield* runtime.bind(handle, request).pipe(
                        Effect.provideService(RequestExecutor.CurrentRequestSeal, {
                          seal: (observation) =>
                            Effect.gen(function* () {
                              captured.value = yield* credentials
                                .captureNative({ runtime: handle, request, observation, ...input })
                                .pipe(
                                  Effect.provideService(Scope.Scope, scope),
                                  args.mode === "approval-source-copy"
                                    ? Effect.provideService(Config.Service, { entries: actualConfig.entries })
                                    : (effect) => effect,
                                )
                              return yield* Effect.die("CONTROLLED_APPROVAL_STOP_BEFORE_FETCH")
                            }).pipe(Effect.orDie),
                        }),
                      )
                      yield* client
                        .generate(request)
                        .pipe(Effect.provideService(RequestExecutor.CurrentRequestSeal, seal), Effect.exit)
                      if (!captured.value) return yield* WorkRouteApproval.failure("NATIVE_OBSERVATION_REQUIRED")
                      progress.approvalEvidence = yield* credentials.authority.captured(captured.value)
                      return captured.value
                    }),
                }),
                Effect.tapError((error) =>
                  Effect.sync(() => {
                    progress.approvalError = "code" in error ? error.code : error._tag
                  }),
                ),
              )
              const record = yield* read()
              const operator = yield* database.db.transaction((tx) => LocalOperator.requireCurrent(tx))
              if (!record) return yield* Effect.die("missing actual approval")
              const valid = yield* credentials.authority
                .verify(
                  record,
                  (yield* database.db.all<{ record_mac: string }>("SELECT record_mac FROM work_route_approval"))[0]!
                    .record_mac,
                )
                .pipe(Effect.exit)
              const tampered = yield* credentials.authority
                .verify(
                  { ...record, policyHash: "f".repeat(64) },
                  (yield* database.db.all<{ record_mac: string }>("SELECT record_mac FROM work_route_approval"))[0]!
                    .record_mac,
                )
                .pipe(Effect.exit)
              return {
                receipt,
                coldReused: !!previous,
                macVerified: Exit.isSuccess(valid),
                tamperRejected: Exit.isFailure(tampered),
                basicGeneration: operator.credential_generation,
                operatorRevision: operator.revision,
                schemaRevision: (yield* database.db.all<{ count: number }>(
                  "SELECT count(*) count FROM work_route_approval",
                ))[0]!.count,
                fixtureOnlyContract: true,
              }
            }).pipe(
              Effect.provideService(LocalOperator.Runtime, identity),
              Effect.provide(
                ProviderCredentialBinding.layer.pipe(
                  Layer.provide(
                    Layer.succeed(ProviderCredentialBinding.Contract, {
                      resolve: () =>
                        Effect.succeed({
                          modelRevision: "controlled-signed-test-only",
                          counterEndpoint: "https://127.0.0.1:1/v1/responses/input_tokens",
                          contractID: "controlled-fixture-contract",
                          contractHash: "1".repeat(64),
                          tokenizerIdentity: "controlled-only",
                          completionLimit: 4096,
                          factoryHash: "2".repeat(64),
                          adapterHash: "3".repeat(64),
                          loweringHash: "4".repeat(64),
                          framingHash: "5".repeat(64),
                        }),
                    }),
                  ),
                ),
              ),
            )
          }
          if (args.mode.startsWith("capture")) {
            const installation = yield* LocalTaskAuthority.initializeInstallation()
            const captured: {
              handle?: NativeRuntime.CredentialCapture
              description?: NativeRuntime.CredentialDescription
              copied?: string
              copiedObservation?: string
              stoppedAtSeal?: boolean
            } = {}
            const scope = yield* Scope.make()
            yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
            const seal = yield* runtime.bind(handle, request).pipe(
              Effect.provideService(RequestExecutor.CurrentRequestSeal, {
                seal: (observation) =>
                  Effect.gen(function* () {
                    const placement = {
                      instanceID: installation.instanceID,
                      operatorID: "fixture-operator",
                      targetID: args.mode === "capture-other-target" ? "other" : "target",
                      securityNamespaceID: "fixture-namespace",
                      projectScopeKey: "fixture-project",
                      locationKey: "fixture-location",
                      canonicalRoot: session.location.directory,
                      namespaceBindingHash: "a".repeat(64),
                    }
                    const invalid = yield* runtime
                      .captureNative(handle, request, { ...observation }, placement)
                      .pipe(Effect.provideService(Scope.Scope, scope), Effect.exit)
                    captured.copiedObservation = invalid._tag
                    captured.handle = yield* runtime
                      .captureNative(handle, request, observation, placement)
                      .pipe(Effect.provideService(Scope.Scope, scope))
                    captured.description = yield* runtime.credential(captured.handle)
                    captured.copied = (yield* runtime.credential({ ...captured.handle }).pipe(Effect.exit))._tag
                    captured.stoppedAtSeal = true
                    return yield* Effect.die("CONTROLLED_CAPTURE_STOP_BEFORE_FETCH")
                  }).pipe(Effect.orDie),
              }),
            )
            if (args.mode === "capture-rotated") process.env.DAC_FIXTURE_NATIVE_KEY = "fixture-rotated-key"
            const stopped = yield* client
              .generate(request)
              .pipe(
                Effect.provideService(RequestExecutor.CurrentRequestSeal, seal),
                args.mode === "capture-rotated"
                  ? Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv()))
                  : (effect) => effect,
                Effect.exit,
              )
            progress.capture = {
              observed: !!captured.handle,
              described: !!captured.description,
              stoppedAtSeal: captured.stoppedAtSeal,
            }
            if (!captured.handle || !captured.description || Exit.isSuccess(stopped) || !captured.stoppedAtSeal)
              return yield* Effect.die(Exit.isFailure(stopped) ? Cause.pretty(stopped.cause) : "capture did not stop")
            yield* Scope.close(scope, Exit.void)
            return {
              ...captured.description,
              copied: captured.copied,
              copiedObservation: captured.copiedObservation,
              closed: (yield* runtime.credential(captured.handle).pipe(Effect.exit))._tag,
              publicFingerprint: description.sourceHash,
            }
          }
          const seal =
            args.mode === "ordinary-proxy"
              ? yield* RequestExecutor.CurrentRequestSeal
              : yield* runtime.bind(handle, request)
          yield* client
            .generate(args.mode === "request-copy" ? { ...request } : request)
            .pipe(
              Effect.provideService(RequestExecutor.CurrentRequestSeal, seal),
              args.mode === "requestinit"
                ? Effect.provideService(FetchHttpClient.RequestInit, { headers: { authorization: "forbidden" } })
                : (effect) => effect,
              args.mode === "retry" ? Effect.provideService(RequestExecutor.CurrentRetryLimit, 1) : (effect) => effect,
              args.mode === "redirect-policy"
                ? Effect.provideService(RequestExecutor.CurrentRedirectPolicy, "follow")
                : (effect) => effect,
              args.mode === "auth-provider-rotate"
                ? Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv()))
                : (effect) => effect,
              Effect.timeout(
                args.mode === "cancel-before" || args.mode === "cancel-inflight" ? "3 seconds" : "15 seconds",
              ),
            )
          return {
            description,
            sameClient: SessionRunnerModel.construction(resolved)?.client === client,
            bootstrap: NativeBootstrap.current(),
            observations,
            live: runtime.live(),
          }
        }).pipe(Effect.provide(locations.get(session.location)))
      }).pipe(
        Effect.scoped,
        Effect.provideService(RequestExecutor.CurrentRetryLimit, 0),
        Effect.provideService(RequestExecutor.CurrentRedirectPolicy, "manual"),
        Effect.provideService(RequestExecutor.CurrentRequestSeal, {
          seal: (input) =>
            Effect.gen(function* () {
              observations.push({
                bodyHash: input.bodyHash,
                wireHash: input.wireHash,
                bodyLength: input.bodyLength,
                method: input.method,
                url: input.url,
              })
              if (args.mode === "cancel-before") yield* Effect.never
              if (args.mode === "late-drift") process.env.HTTPS_PROXY = "http://127.0.0.1:1"
              if (args.mode === "manifest-drift")
                yield* Effect.promise(() => Bun.write(`${process.execPath}.native-installation.json`, "{}"))
            }),
        }),
        Effect.exit,
      ),
    )
    const liveAfter = await AppRuntime.runPromise(Effect.map(NativeRuntime.Service, (runtime) => runtime.live()))
    await AppRuntime.dispose()
    if (retained.runtime && retained.handle && retained.scope) {
      progress.closedRoot = {
        live: retained.runtime.live(),
        handle: (await Effect.runPromiseExit(retained.runtime.describe(retained.handle)))._tag,
      }
      await Effect.runPromise(Scope.close(retained.scope, Exit.void))
    }
    await Bun.write(
      process.env.DAC_NATIVE_FACTORY_RESULT!,
      JSON.stringify(
        {
          mode: args.mode,
          ok: Exit.isSuccess(result),
          liveAfter,
          progress,
          ...(Exit.isSuccess(result) ? { result: result.value } : { error: Cause.pretty(result.cause) }),
          fixtureOnly: { debugCommandSubstitution: true, devMint: true, productionWorkProfile: false },
        },
        null,
        2,
      ),
    )
    process.exitCode = Exit.isSuccess(result) ? 0 : 2
  },
})
