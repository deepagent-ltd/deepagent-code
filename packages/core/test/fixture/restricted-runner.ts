export * as RestrictedRunnerFixture from "./restricted-runner"

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { LLMClient, RequestExecutor } from "@deepagent-code/llm/route"
import { Cause, Effect, Fiber, Layer, LayerMap, Option, Schema, Scope } from "effect"
import { sql } from "drizzle-orm"
import { AgentV2 } from "../../src/agent"
import { AgentGateway } from "../../src/agent-gateway"
import { Catalog } from "../../src/catalog"
import { Config } from "../../src/config"
import { SessionContext } from "../../src/context-federation/session-context"
import { ContextQueryAuthorization } from "../../src/context-federation/query-authorization"
import { ProductionV2Sources } from "../../src/context-federation/production-adapters"
import { Database } from "../../src/database/database"
import { EventV2 } from "../../src/event"
import { FSUtil } from "../../src/fs-util"
import { Git } from "../../src/git"
import { Location } from "../../src/location"
import { LocationServiceMap } from "../../src/location-layer"
import { Project } from "../../src/project"
import { PermissionV2 } from "../../src/permission"
import { AbsolutePath } from "../../src/schema"
import { SessionExecution } from "../../src/session/execution"
import { SessionExecutionLocal } from "../../src/session/execution/local"
import { SessionRunner } from "../../src/session/runner"
import { layer } from "../../src/session/runner/llm"
import { SessionRunnerModel } from "../../src/session/runner/model"
import { V2OwnerAuthorization } from "../../src/session/runner/v2-owner-authorization"
import { V2OwnerAuthorizationTable } from "../../src/session/runner/v2-owner-authorization.sql"
import { V2ProviderTurn } from "../../src/session/runner/v2-provider-turn"
import { V2ToolEffect } from "../../src/session/runner/v2-tool-effect"
import { SessionSchema } from "../../src/session/schema"
import { SessionStore } from "../../src/session/store"
import { WorkAuthoritySchema } from "../../src/session/work-authority.schema"
import { WorkAuthority } from "../../src/session/work-authority"
import { WorkExecutionProfile } from "../../src/session/work-execution-profile"
import { WorkFileCapability } from "../../src/session/work-file-capability"
import { WorkToolPolicy } from "../../src/session/work-tool-policy"
import { WorkCountAcquisition } from "../../src/session/work-count-acquisition"
import { WorkCountAcquisitionSchema } from "../../src/session/work-count-acquisition.schema"
import { WorkCountAcquisitionTable } from "../../src/session/work-count-acquisition.sql"
import { V2ProviderTurnReceiptTable } from "../../src/session/runner/v2-provider-turn.sql"
import { SessionProviderAttemptTable } from "../../src/context-federation/session-sql"
import { CanonicalJson } from "../../src/util/canonical-json"
import { eq } from "drizzle-orm"
import { WorkRoutePolicy } from "../../src/session/work-route-policy"
import { SkillGuidance } from "../../src/skill/guidance"
import { SystemContextRegistry } from "../../src/system-context/registry"
import { Delegation } from "../../src/tool/delegation"
import { ToolRegistry } from "../../src/tool/registry"
import { Hash } from "../../src/util/hash"
import { WorkAuthorityFixture } from "./work-authority"
import { WorkProviderDispatchFixture } from "./work-provider-dispatch"
import { StartupInventory } from "../../src/session/runner/startup-inventory"
import { WorkRouteFixture } from "./work-route"

export const scenarios = [
  "missing-profile",
  "retired-placement",
  "missing-placement",
  "retired-after-count",
  "revoked-before-model",
  "revoked-after-count",
  "missing-count",
  "bad-counter-response",
  "missing-runtime",
  "wrong-count",
  "runtime-drift",
  "body-overlay",
  "complete",
  "source-refresh-after-slow-io",
  "source-near-expiry-before-promotion",
  "source-multi-tool-history",
  "revoked-before-result",
  "retired-before-result",
  "activity-rollback",
  "drop",
  "missing-usage",
  "interrupt",
  "deadline",
] as const
export type Scenario = (typeof scenarios)[number]
const build: V2ProviderTurn.BuildIdentity = {
  subjectCommit: "a".repeat(40),
  subjectTree: "b".repeat(40),
  schemaDigest: "c".repeat(64),
  buildID: "e".repeat(64),
  packageDigest: "d".repeat(64),
}
const fail = () =>
  new WorkAuthoritySchema.Error({ code: "PROFILE_UNAVAILABLE", message: "Controlled fixture evidence unavailable" })

export async function create(scenario: Scenario, options?: {
  readonly projectDefinitionHash: string
  readonly generation: (turn: number) => Promise<Response>
}) {
  const observed = { counts: [] as string[], models: 0, preflights: 0, sourceRefreshes: 0,
    sourceFreshRequests: [] as boolean[], nearExpiryCreated: 0, observationElapsedMs: 0, trips: [] as string[], canceled: 0 }
  const control = { filename: "" }
  const source = await WorkProviderDispatchFixture.create({
    ...(options ? { profile: "project" as const, generation: options.generation } : {}),
    onCancel: () => {
      observed.canceled++
    },
    beforeTerminal: async () => {
      if (scenario === "source-refresh-after-slow-io") await Bun.sleep(1100)
      if (!["revoked-before-result", "retired-before-result"].includes(scenario)) return
      // Independent connection mutates current authority AFTER actual HTTP receipt, before the
      // provider sends completed. It does not modify or forge the resulting Work/receipt rows.
      const { Database } = await import("bun:sqlite")
      const connection = new Database(control.filename)
      try {
        connection.run(
          scenario === "revoked-before-result"
            ? "UPDATE test_work_source SET enabled=0"
            : "UPDATE context_location_identity SET retired_at=1",
        )
      } finally {
        connection.close()
      }
    },
    counter: async (request) => {
      assert.equal(new URL(request.url).pathname, "/v1/responses/input_tokens")
      assert.equal(request.method, "POST")
      observed.counts.push(await request.text())
      if (scenario === "source-refresh-after-slow-io") await Bun.sleep(1100)
      // Approved deterministic contract for this fixed text only, not an arbitrary tokenizer.
      return Response.json({
        object: "response.input_tokens",
        input_tokens: scenario === "bad-counter-response" ? 42 : 41,
      })
    },
  })
  control.filename = source.filename
  const candidate = {
    ...source.candidate,
    binding: Schema.decodeUnknownSync(WorkAuthoritySchema.Binding)({
      ...source.candidate.binding,
      ...(options && source.candidate.binding.schemaVersion === "work-execution.v2" ? {
        toolPolicy: { ...source.candidate.binding.toolPolicy,
          capabilities: [{ toolID: "read", operations: ["read" as const], definitionHash: options.projectDefinitionHash }] },
      } : {}),
      ...(scenario === "deadline"
        ? { deadline: Date.now() + 3000, budget: { ...source.candidate.binding.budget, maxDurationMs: 5000 } }
        : {}),
    }),
  }
  const keys = V2OwnerAuthorization.generateAuthorizationKeyPair()
  const fixture = { ...source, candidate, scenario, observed, publicKey: keys.publicKeyPem }
  await WorkProviderDispatchFixture.open(
    fixture,
    Effect.gen(function* () {
      yield* WorkProviderDispatchFixture.admit(fixture, { count: false })
      const fields = {
        authorizationID: "restricted-runner-owner",
        campaignID: "restricted-runner",
        ...build,
        validFrom: Date.now() - 1000,
        expiresAt: Date.now() + 120_000,
      }
      yield* (yield* Database.Service).db.insert(V2OwnerAuthorizationTable).values({
        authorization_id: fields.authorizationID,
        campaign_id: fields.campaignID,
        subject_commit: build.subjectCommit,
        subject_tree: build.subjectTree,
        schema_digest: build.schemaDigest,
        build_id: build.buildID,
        package_digest: build.packageDigest,
        valid_from: fields.validFrom,
        expires_at: fields.expiresAt,
        status: "active",
        signature_digest: V2OwnerAuthorization.signAuthorization(keys.privateKeyPem, fields),
        authorization_digest: Hash.sha256(V2OwnerAuthorization.authorizationPayload(fields)),
        created_at: Date.now(),
      })
    }),
  )
  source.state.mode =
    scenario === "drop" || scenario === "missing-usage"
      ? scenario
      : scenario === "interrupt" || scenario === "deadline"
        ? "wait"
        : "complete"
  return {
    ...fixture,
    async close() {
      source.server.stop(true)
    },
  }
}
export type Fixture = Awaited<ReturnType<typeof create>>
export type Context = Omit<Fixture, "close" | "server">

/** Real coordinator and real main runner. Only unused ordinary-domain boundaries are tripwires;
 * SQL authority, canonical writer, projector, provider lifecycle and HTTP encoder are production. */
export async function open<A, E>(
  fixture: Context,
  body: Effect.Effect<A, E, WorkProviderDispatchFixture.Services | SessionExecution.Service>,
  options?: { readonly project: Effect.Effect<{
    readonly tools: ToolRegistry.Interface
    readonly agents: AgentV2.Interface
    readonly files: WorkFileCapability.Interface
    readonly proof: WorkToolPolicy.LeafProof["Service"]
    readonly count?: WorkCountAcquisition.Authority["Service"]
  }, WorkAuthoritySchema.Error, Database.Service | WorkExecutionProfile.Service | Scope.Scope>
    readonly onPrepare?: Effect.Effect<void, WorkAuthoritySchema.Error, Database.Service>
    readonly count?: WorkCountAcquisition.Authority["Service"]
  },
) {
  return WorkProviderDispatchFixture.open(
    fixture,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const db = database.db
      const originalVerifier = yield* Effect.gen(function* () { return yield* WorkAuthority.Verifier }).pipe(Effect.provide(WorkAuthorityFixture.verifier))
      const lease = { deadline: 0 }
      const sourceTiming = ["source-refresh-after-slow-io", "source-near-expiry-before-promotion", "source-multi-tool-history"].includes(fixture.scenario)
      const refresh = (fresh = false) => Effect.gen(function* () {
        fixture.observed.sourceFreshRequests.push(fresh)
        if (["source-near-expiry-before-promotion", "source-multi-tool-history"].includes(fixture.scenario) && !fresh && lease.deadline > performance.now()) return
        if (options?.onPrepare) yield* options.onPrepare.pipe(Effect.provideService(Database.Service, database))
        lease.deadline = performance.now() + 1000
        fixture.observed.sourceRefreshes++
      })
      const verifier = sourceTiming ? Layer.succeed(WorkAuthority.Verifier, {
        ...originalVerifier,
        authorizeSource: (tx, binding) => Effect.gen(function* () {
          if (fixture.scenario === "source-near-expiry-before-promotion") yield* Effect.sleep("80 millis")
          if (performance.now() >= lease.deadline) return yield* new WorkAuthoritySchema.Error({ code: "WORK_REVOKED", message: "Controlled current source witness expired" })
          return yield* originalVerifier.authorizeSource(tx, binding)
        }),
      }) : WorkAuthorityFixture.verifier
      const base = Layer.mergeAll(
        Layer.succeed(Database.Service, database),
        Layer.succeed(EventV2.Service, yield* EventV2.Service),
        Layer.succeed(SessionStore.Service, yield* SessionStore.Service),
        Layer.succeed(SessionContext.Service, yield* SessionContext.Service),
        Layer.succeed(V2ProviderTurn.Service, yield* V2ProviderTurn.Service),
        verifier,
      )
      const trip = (name: string) =>
        Effect.sync(() => {
          fixture.observed.trips.push(name)
          throw new Error(`Unexpected ordinary boundary: ${name}`)
        })
      const evidence = Layer.succeed(WorkRoutePolicy.Evidence, {
        resolve: () =>
          db.get<{ value: string }>(sql`SELECT value FROM test_dispatch_evidence WHERE id = 'route'`).pipe(
            Effect.flatMap((row) =>
              row
                ? Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(row.value).pipe(
                    Effect.map((value) => value as WorkRoutePolicy.RouteEvidence),
                    Effect.mapError(fail),
                  )
                : Effect.fail(fail()),
            ),
            Effect.orDie,
          ),
        readCount: () =>
          db.get<{ value: string }>(sql`SELECT value FROM test_dispatch_evidence WHERE id = 'count'`).pipe(
            Effect.flatMap((row) =>
              row
                ? Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(row.value).pipe(
                    Effect.map((value) => value as WorkRoutePolicy.CountReceipt),
                    Effect.mapError(fail),
                  )
                : Effect.fail(fail()),
            ),
            Effect.orDie,
          ),
      })
      const model =
        fixture.scenario === "body-overlay"
          ? fixture.candidate.request.model.route
              .with({ http: { body: { max_output_tokens: 99999 } } })
              .model({ id: fixture.candidate.request.model.id })
          : fixture.candidate.request.model
      const profile = Layer.succeed(WorkExecutionProfile.Service, {
        preflight: () =>
          Effect.sync(() => {
            fixture.observed.preflights++
          }).pipe(Effect.andThen(sourceTiming ? refresh() : Effect.void)),
        ...(sourceTiming ? { prepareSource: (_work, options) => refresh(options?.fresh === true) } : {}),
        observe: (input) =>
          Effect.gen(function* () {
            if (fixture.scenario === "missing-runtime") return yield* fail()
            assert.equal(input.resolved.model, model)
            assert.equal(input.resolved.model.provider, fixture.candidate.runtime.providerID)
            assert.equal(input.resolved.model.route.protocol, fixture.candidate.runtime.protocol)
            if (["source-near-expiry-before-promotion", "source-multi-tool-history"].includes(fixture.scenario)) {
              const started = performance.now()
              yield* Effect.sleep("1100 millis")
              fixture.observed.observationElapsedMs = performance.now() - started
              // A valid concurrent cached observation can arrive near its deadline while model
              // resolution/runtime acquisition is in progress. Default preparation must preserve
              // that old deadline; the real turn's promotion boundary must explicitly ask fresh.
              lease.deadline = performance.now() + 50
              fixture.observed.nearExpiryCreated++
            }
            return fixture.scenario === "runtime-drift"
              ? { ...fixture.candidate.runtime, configurationHash: "0".repeat(64) }
              : fixture.candidate.runtime
          }),
        bind: () => Effect.gen(function* () {
          const seal = yield* RequestExecutor.CurrentRequestSeal
          if (!seal) return yield* fail()
          return seal
        }),
        current: () => Effect.void,
        acquireCount: (input) =>
          Effect.gen(function* () {
            if (fixture.scenario === "missing-count") return yield* fail()
            assert.equal(input.route.counter.endpoint, fixture.candidate.evidence.counter.endpoint)
            const response = yield* Effect.tryPromise({
              try: () =>
                fetch(input.route.counter.endpoint, {
                  method: "POST",
                  body: input.wire.bodyText,
                  redirect: "manual",
                  signal: AbortSignal.timeout(3000),
                }).then(async (response) => ({ status: response.status, body: await response.json() })),
              catch: fail,
            })
            assert.deepEqual(response, { status: 200, body: { object: "response.input_tokens", input_tokens: 41 } })
            const row = yield* db
              .get<{ binding: string }>(sql`SELECT binding FROM work_execution WHERE work_id = ${input.workID}`)
              .pipe(Effect.orDie)
            assert(row)
            const binding = Schema.decodeUnknownSync(Schema.fromJsonString(WorkAuthoritySchema.Binding))(row.binding)
            const dispatch = yield* WorkRouteFixture.dispatch(db, input.workID, input.receiptID).pipe(Effect.orDie)
            const legacy = WorkRouteFixture.receipt(
              { binding, auditedText: WorkRouteFixture.TEXT, runtime: input.runtime, wire: input.wire,
                dispatch },
              input.route,
            )
            const receipt = binding.schemaVersion === "work-execution.v2" ? yield* Effect.gen(function* () {
              yield* refresh(true)
              const current = yield* WorkAuthority.get(db, input.workID)
              const turn = yield* db.select().from(V2ProviderTurnReceiptTable)
                .where(eq(V2ProviderTurnReceiptTable.receipt_id, input.receiptID)).get().pipe(Effect.orDie)
              const attempt = turn?.provider_attempt_id ? yield* db.select().from(SessionProviderAttemptTable)
                .where(eq(SessionProviderAttemptTable.attempt_id, turn.provider_attempt_id)).get().pipe(Effect.orDie) : undefined
              assert(current && turn?.activity_id && turn.provider_turn_seq && attempt?.selection_id && attempt.projection_hash)
              const previous = yield* db.transaction((tx) => WorkToolPolicy.previous(tx, current, input.receiptID))
              const prior = previous ? yield* WorkCountAcquisition.getTurn(db, input.workID,
                Hash.sha256(CanonicalJson.stringify(["work-provider-turn.v1", input.workID,
                  previous.receipt.session_id, previous.receipt.activity_id, previous.receipt.provider_turn_seq]))) : undefined
              const inspected = WorkRoutePolicy.inspect({ binding, auditedText: WorkRouteFixture.TEXT,
                runtime: input.runtime, wire: input.wire }, { allowLoopbackHTTP: true })
              assert(inspected.ok)
              const project = WorkRoutePolicy.projectCountBinding({ ...dispatch, project: {
                rootWorkID: binding.rootWorkID,
                turn: { key: Hash.sha256(CanonicalJson.stringify(["work-provider-turn.v1", input.workID,
                    turn.session_id, turn.activity_id, turn.provider_turn_seq])),
                  activityID: turn.activity_id, providerTurnSeq: turn.provider_turn_seq,
                  contextSelectionID: attempt.selection_id, contextProjectionHash: attempt.projection_hash,
                  historyPromptEpoch: turn.history_prompt_epoch, historySourceEndMessageID: turn.history_source_end_message_id },
                predecessor: previous && prior ? { acquisitionID: prior.acquisitionID, receiptID: previous.receipt.receipt_id,
                  outcomeHash: previous.receipt.outcome_hash!,
                  toolTerminalHash: previous.toolTerminalHash } : null,
                toolAdvertisementHash: inspected.value.toolAdvertisementHash,
              } }, input.route, inspected.value)
              assert(project)
              const now = Date.now()
              const record = Schema.decodeUnknownSync(WorkCountAcquisitionSchema.ProjectRecord)({ version: 2,
                acquisitionID: `fixture_count_${turn.provider_turn_seq}`, binding: project, state: "settled", revision: 3,
                ownerToken: turn.owner_token, bootID: "fixture_boot", deadline: now + 9000,
                result: { responseHash: legacy.responseHash, inputTokens: legacy.tokens, countedAt: now, expiresAt: now + 9000 },
                errorCode: null, createdAt: now, updatedAt: now, sendingAt: now, terminalAt: now })
              const authority = yield* Effect.serviceOption(WorkCountAcquisition.Authority)
              assert(Option.isSome(authority) && authority.value.authenticateProject)
              const mac = yield* authority.value.authenticateProject(record)
              // Controlled counter evidence only. The store's original reader authenticates
              // this exact fixture MAC row; this seam makes no Native/provider qualification.
              yield* db.insert(WorkCountAcquisitionTable).values({
                acquisition_id: record.acquisitionID, work_id: input.workID, slot_version: 2,
                root_work_id: project.rootWorkID, activity_id: project.turn.activityID,
                provider_turn_seq: project.turn.providerTurnSeq, turn_key: project.turn.key,
                input_id: project.inputID, session_id: project.sessionID, provider_receipt_id: project.providerReceiptID,
                provider_attempt_id: project.providerAttemptID, binding_hash: Hash.sha256(CanonicalJson.stringify(project)),
                approval_id: project.approvalID, approval_revision: project.approvalRevision,
                state: record.state, revision: record.revision, owner_token: record.ownerToken, boot_id: record.bootID,
                deadline: record.deadline, record: CanonicalJson.stringify(record), record_hash: Hash.sha256(CanonicalJson.stringify(record)),
                record_mac: mac, created_at: now, updated_at: now,
              }).run().pipe(Effect.orDie)
              return { ...legacy, version: "native-project-count-receipt.v1" as const, binding: project }
            }) : legacy
            yield* db
              .run(
                sql`INSERT INTO test_dispatch_evidence VALUES ('count', ${JSON.stringify(fixture.scenario === "wrong-count" ? { ...receipt, bodyHash: "0".repeat(64) } : receipt)}) ON CONFLICT(id) DO UPDATE SET value=excluded.value`,
              )
              .pipe(Effect.orDie)
            if (fixture.scenario === "revoked-after-count")
              yield* db.run("UPDATE test_work_source SET enabled=0").pipe(Effect.orDie)
            if (fixture.scenario === "retired-after-count")
              yield* db.run("UPDATE context_location_identity SET retired_at=1").pipe(Effect.orDie)
          }).pipe(Effect.mapError(fail)),
      })
      const policy = Layer.mergeAll(
        base,
        evidence,
        ...(fixture.scenario === "missing-profile" ? [] : [profile]),
        ...(options?.count ? [Layer.succeed(WorkCountAcquisition.Authority, options.count)] : []),
        Layer.succeed(V2ProviderTurn.CurrentOwnerCampaign, "restricted-runner"),
        Layer.succeed(V2ProviderTurn.CurrentBuildIdentity, build),
        Layer.succeed(V2ProviderTurn.CurrentOwnerAuthorizationPublicKey, fixture.publicKey),
      )
      const project = options ? yield* options.project.pipe(Effect.provide(policy)) : undefined
      const projectPolicy = project ? Layer.mergeAll(
        Layer.succeed(WorkFileCapability.Service, project.files), Layer.succeed(WorkToolPolicy.LeafProof, project.proof),
        ...(project.count ? [Layer.succeed(WorkCountAcquisition.Authority, project.count)] : []),
      ) : Layer.empty
      const ordinary = Layer.mergeAll(
        project ? Layer.succeed(AgentV2.Service, project.agents)
          : Layer.mock(AgentV2.Service, { all: () => trip("agents"), get: () => trip("agent") }),
        Layer.succeed(AgentGateway.Runtime, {
          snapshot: {
            schemaVersion: "deepagent_generic_agent_runtime.v1",
            mode: "off",
            agentMode: "general",
            implementation: "visible_skeleton",
            agentManaged: false,
            originalPathAllowed: false,
            providerExecutedToolPolicy: "deny_by_default",
            knowledgeEnabled: false,
          },
          active: false,
          baseDir: fixture.root,
          runsDir: fixture.root,
          selfLearning: "manual",
          durableLearning: false,
          withStorage: () => {
            throw new Error("Unexpected gateway storage")
          },
          ensureKnowledgeSeeded: async () => {
            throw new Error("Unexpected gateway seed")
          },
          systemPrompt: () => {
            throw new Error("Unexpected gateway")
          },
          volatileRoundContext: () => {
            throw new Error("Unexpected gateway")
          },
          volatileContinuationContext: () => {
            throw new Error("Unexpected gateway")
          },
        }),
        project ? Layer.succeed(ToolRegistry.Service, project.tools)
          : Layer.mock(ToolRegistry.Service, { materialize: () => trip("tools") }),
        ...(project ? [Layer.succeed(WorkFileCapability.Service, project.files),
          Layer.succeed(WorkToolPolicy.LeafProof, project.proof),
          ...(project.count ? [Layer.succeed(WorkCountAcquisition.Authority, project.count)] : [])] : []),
        Layer.mock(PermissionV2.Service, {}),
        Layer.mock(SystemContextRegistry.Service, { load: () => trip("context") }),
        Layer.mock(SkillGuidance.Service, { load: () => trip("skills") }),
        Layer.effect(
          FSUtil.Service,
          Effect.map(
            FSUtil.Service,
            (service) =>
              new Proxy(service, {
                get(target, key) {
                  const value = Reflect.get(target, key)
                  if (typeof value !== "function") return value
                  return () => {
                    fixture.observed.trips.push("filesystem:" + String(key))
                    throw new Error("Unexpected filesystem access")
                  }
                },
              }),
          ),
        ).pipe(Layer.provide(FSUtil.defaultLayer)),
        Layer.mock(Git.Service, {}),
        Layer.mock(Catalog.Service, {
          provider: { get: () => trip("provider"), all: () => trip("provider"), available: () => trip("provider") },
          model: {
            get: () => trip("catalog"),
            all: () => trip("catalog"),
            available: () => trip("catalog"),
            default: () => trip("catalog"),
            small: () => trip("catalog"),
          },
        }),
        // These two configuration reads occur at Location-layer construction. No project/config
        // discovery is installed, and any execution-stage ordinary-domain access remains a tripwire.
        Layer.succeed(Config.Service, { entries: () => Effect.succeed([]) }),
        Layer.succeed(SessionRunner.CurrentOnSessionSettled, () => trip("learning")),
        Layer.succeed(ProductionV2Sources, {}),
        ContextQueryAuthorization.defaultLayer,
        Layer.succeed(Location.Service, {
          directory: AbsolutePath.make(path.join(fixture.root, "project")),
          project: { id: Project.ID.make("global"), directory: AbsolutePath.make(path.join(fixture.root, "project")) },
        }),
        SessionRunnerModel.layerWith(() =>
          Effect.sync(() => {
            fixture.observed.models++
            return { model }
          }),
        ),
      )
      const runner = layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            policy,
            ordinary,
            V2ProviderTurn.ownerAuthorizationLayer,
            V2ToolEffect.layer.pipe(Layer.provide(base)),
            LLMClient.layer.pipe(Layer.provide(RequestExecutor.defaultLayer)),
          ),
        ),
      )
      const locations = Layer.effect(
        LocationServiceMap,
        LayerMap.make(() => runner).pipe(
          // The actual keyed map intentionally exposes only the runner needed by coordinator.drain;
          // unused Location applications are tripwires above, not a replacement Session runner.
          Effect.map((value) => value as unknown as LocationServiceMap["Service"]),
        ),
      )
      const execution = SessionExecutionLocal.layer.pipe(
        Layer.provide(Layer.mergeAll(policy, projectPolicy, locations, Delegation.delegationSlotLayer)),
      )
      return yield* body.pipe(Effect.provide(execution), Effect.provide(policy), Effect.provide(projectPolicy))
    }),
  )
}

export const facts = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  return {
    ...(yield* WorkProviderDispatchFixture.rows),
    inventory: yield* StartupInventory.classifyStartup(db),
    sessions: yield* db.all<Record<string, unknown>>("SELECT id,execution_claim_token FROM session"),
    messages: yield* db.all<Record<string, unknown>>("SELECT id,type,data FROM session_message"),
    inputs: yield* db.all<Record<string, unknown>>("SELECT id,promoted_seq FROM session_input"),
    outbox: yield* db.all<Record<string, unknown>>("SELECT * FROM im_reply_outbox"),
    activities: yield* db.all<Record<string, unknown>>(
      "SELECT activity_id,state,final_message_id FROM session_activity",
    ),
  }
})

export const replay = Effect.gen(function* () {
  const execution = yield* SessionExecution.Service
  const id = SessionSchema.ID.make("ses_work_wire-policy")
  const resumed = yield* execution.resume(id).pipe(Effect.exit)
  yield* execution.wake(id).pipe(Effect.exit)
  yield* execution.awaitIdle(id).pipe(Effect.exit)
  return {
    refused: resumed._tag === "Failure",
    error: resumed._tag === "Failure" ? Cause.pretty(resumed.cause) : null,
    facts: yield* facts,
  }
})

export async function run(scenario: Scenario) {
  const fixture = await create(scenario)
  try {
    const result = await open(
      fixture,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        if (scenario === "revoked-before-model") yield* db.run("UPDATE test_work_source SET enabled=0")
        if (scenario === "retired-placement") yield* db.run("UPDATE context_location_identity SET retired_at=1")
        if (scenario === "missing-placement") yield* db.run("DELETE FROM context_location_identity")
        if (scenario === "activity-rollback")
          yield* db.run(
            "CREATE TRIGGER fixture_abort_activity BEFORE UPDATE OF state ON session_activity WHEN NEW.state='settled' AND EXISTS(SELECT 1 FROM work_execution WHERE session_id=NEW.session_id AND outcome='succeeded') BEGIN SELECT RAISE(ABORT,'fixture_terminal_commit_failure'); END",
          )
        const execution = yield* SessionExecution.Service
        const sessionID = SessionSchema.ID.make(fixture.candidate.binding.sessionID)
        const pending = yield* execution.resume(sessionID).pipe(Effect.exit, Effect.forkChild)
        if (scenario === "interrupt") {
          yield* Effect.gen(function* () {
            while (!fixture.state.bodies.length) yield* Effect.sleep("5 millis")
          }).pipe(Effect.timeout("5 seconds"))
          yield* execution.interrupt(sessionID)
        }
        const exit = yield* Fiber.join(pending)
        return {
          success: exit._tag === "Success",
          error: exit._tag === "Failure" ? Cause.pretty(exit.cause) : null,
          facts: yield* facts,
        }
      }),
    )
    const before = ["missing-profile", "revoked-before-model", "retired-placement", "missing-placement"].includes(
      scenario,
    )
    const resultRefused = ["revoked-before-result", "retired-before-result", "activity-rollback"].includes(scenario)
    const knownUsage = ["complete", "source-refresh-after-slow-io", "source-near-expiry-before-promotion"].includes(scenario) || resultRefused
    const dispatched = knownUsage || ["drop", "missing-usage", "interrupt", "deadline"].includes(scenario)
    const counted =
      dispatched ||
      ["wrong-count", "bad-counter-response", "revoked-after-count", "retired-after-count"].includes(scenario)
    assert.equal(result.success, ["complete", "source-refresh-after-slow-io", "source-near-expiry-before-promotion"].includes(scenario), result.error ?? "unexpected outcome")
    assert.deepEqual(fixture.observed.trips, [])
    if (scenario === "source-refresh-after-slow-io") assert(fixture.observed.sourceRefreshes >= 5)
    if (scenario === "source-near-expiry-before-promotion") {
      assert.equal(fixture.observed.nearExpiryCreated, 1)
      assert(fixture.observed.observationElapsedMs >= 1100)
      assert(fixture.observed.sourceFreshRequests.filter(Boolean).length >= 2)
    }
    assert.equal(fixture.observed.models, before ? 0 : 1)
    assert.equal(fixture.observed.counts.length, counted ? 1 : 0)
    assert.equal(fixture.state.bodies.length, dispatched ? 1 : 0)
    assert.equal(result.facts.sessions.length, 1)
    assert.equal(result.facts.sessions[0]?.execution_claim_token, null)
    assert.equal(result.facts.inputs.length, 1)
    assert.equal(result.facts.works.length, 1)
    assert.equal(result.facts.outbox.length, 0)
    if (before) {
      assert.match(result.error ?? "", /WorkAuthority.Error/)
      assert.equal(result.facts.inputs[0]?.promoted_seq, null)
      assert.equal(result.facts.messages.length, 0)
      assert.equal(result.facts.receipts.length, 0)
      assert.equal(result.facts.attempts.length, 0)
    }
    if (!dispatched) assert.equal(result.facts.reservations.length, 0)
    if (dispatched) {
      assert.equal(result.facts.reservations.length, 1)
      assert.equal(result.facts.receipts.length, 1)
      assert.equal(result.facts.attempts.length, 1)
      assert.equal(result.facts.reservations[0]?.reserved_total_tokens, 105)
      assert.deepEqual(fixture.observed.counts, fixture.state.bodies)
      const wire = JSON.parse(fixture.state.bodies[0]!)
      assert.equal(wire.max_output_tokens, 64)
      assert.equal(wire.tools, undefined)
      assert.equal(wire.store, false)
      assert.equal(wire.input.length, 2)
      assert.deepEqual(wire.input[1], { role: "user", content: [{ type: "input_text", text: WorkRouteFixture.TEXT }] })
      assert.equal(
        result.facts.works[0]?.outcome,
        ["complete", "source-refresh-after-slow-io", "source-near-expiry-before-promotion"].includes(scenario) ? "succeeded" : resultRefused ? "pending" : "unknown",
      )
      assert.equal(result.facts.reservations[0]?.state, knownUsage ? "settled" : "unknown")
      assert.equal(result.facts.reservations[0]?.charged_tokens, knownUsage ? 53 : 105)
      assert.equal(result.facts.inventory.byCategory.work_execution.recovery, ["complete", "source-refresh-after-slow-io", "source-near-expiry-before-promotion"].includes(scenario) ? 0 : 1)
      assert.equal(result.facts.inventory.byCategory.work_execution.resolved, ["complete", "source-refresh-after-slow-io", "source-near-expiry-before-promotion"].includes(scenario) ? 1 : 0)
      assert.equal(result.facts.inventory.byCategory.work_dispatch.resolved, knownUsage ? 1 : 0)
    }
    if (resultRefused) {
      assert.equal(result.facts.receipts[0]?.state, "settled")
      assert.equal(result.facts.attempts[0]?.state, "settled")
      assert.equal(result.facts.activities[0]?.state, "active")
      assert.equal(result.facts.activities[0]?.final_message_id, null)
    }
    if (scenario === "activity-rollback")
      await WorkProviderDispatchFixture.open(
        fixture,
        Effect.flatMap(Database.Service, (db) => db.db.run("DROP TRIGGER fixture_abort_activity")),
      )
    if (["complete", "source-refresh-after-slow-io", "source-near-expiry-before-promotion"].includes(scenario)) {
      assert.deepEqual(JSON.parse(String(result.facts.reservations[0]?.actual_usage)), {
        inputTokens: 41,
        completionTokens: 12,
        reasoningTokens: 5,
      })
      assert.equal(result.facts.activities[0]?.state, "settled")
      const assistant = result.facts.messages.find((message) => message.type === "assistant")
      assert(assistant)
      const message = JSON.parse(String(assistant.data))
      assert.equal(message.finish, "stop")
      assert.equal(message.content[0].text, "accepted")
      assert.deepEqual(message.tokens, { input: 41, output: 7, reasoning: 5, cache: { read: 0, write: 0 } })
      assert.equal(result.facts.activities[0]?.final_message_id, assistant.id)
      assert.equal(result.facts.receipts[0]?.state, "settled")
    }
    const same = dispatched ? await open(fixture, replay) : undefined
    if (same) {
      assert.equal(same.refused, true)
      assert.equal(same.facts.works[0]?.outcome, result.facts.works[0]?.outcome)
      assert.equal(same.facts.reservations.length, 1)
      assert.equal(same.facts.attempts.length, 1)
      assert.deepEqual(same.facts.inventory.byCategory.work_execution, result.facts.inventory.byCategory.work_execution)
      assert.equal(fixture.observed.models, 1)
      assert.equal(fixture.observed.counts.length, 1)
      assert.equal(fixture.state.bodies.length, 1)
    }
    const file = { path: fixture.filename, inode: (await fs.stat(fixture.filename)).ino }
    const cold = dispatched ? await coldReplay(fixture) : undefined
    if (cold) {
      assert.deepEqual(cold.file, file)
      assert.equal(cold.result.refused, true)
      assert.equal(cold.observed.models, 0)
      assert.equal(cold.observed.counts.length, 0)
      assert.deepEqual(cold.observed.trips, [])
      assert.equal(cold.result.facts.works[0]?.outcome, result.facts.works[0]?.outcome)
      assert.equal(cold.result.facts.reservations.length, 1)
      assert.equal(cold.result.facts.attempts.length, 1)
      assert.deepEqual(cold.result.facts.inventory.byCategory.work_execution, result.facts.inventory.byCategory.work_execution)
      assert.equal(fixture.observed.counts.length, 1)
      assert.equal(fixture.state.bodies.length, 1)
    }
    if (["interrupt", "deadline"].includes(scenario)) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(fixture.observed.canceled, 1)
    }
    const evidence = {
      scenario,
      pid: process.pid,
      file,
      observed: fixture.observed,
      generation: fixture.state.bodies.length,
      result,
      same,
      cold,
    }
    await Bun.write(path.join(fixture.root, "result.json"), JSON.stringify(evidence, null, 2))
    console.log("RESTRICTED_RESULT", path.join(fixture.root, "result.json"))
    return evidence
  } finally {
    await fixture.close()
  }
}

async function coldReplay(fixture: Context) {
  const data = {
    root: fixture.root,
    filename: fixture.filename,
    scenario: fixture.scenario,
    publicKey: fixture.publicKey,
    candidate: {
      binding: fixture.candidate.binding,
      runtime: fixture.candidate.runtime,
      evidence: fixture.candidate.evidence,
    },
  }
  const filename = path.join(fixture.root, "reopen.json")
  await Bun.write(filename, JSON.stringify(data))
  const child = Bun.spawn([process.execPath, import.meta.filename, "reopen", filename], {
    cwd: fixture.root,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000)
  try {
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    await Bun.write(path.join(fixture.root, "cold.log"), stdout + stderr)
    assert.equal(status, 0, stdout + stderr)
    return (await Bun.file(path.join(fixture.root, "cold-result.json")).json()) as {
      pid: number
      file: { path: string; inode: number }
      observed: Context["observed"]
      result: Effect.Success<typeof replay>
    }
  } finally {
    clearTimeout(timer)
    child.kill()
  }
}

if (import.meta.main) {
  if (process.argv[2] === "reopen") {
    const saved: Pick<Context, "root" | "filename" | "scenario" | "publicKey"> & {
      candidate: Omit<Context["candidate"], "request">
    } = await Bun.file(process.argv[3]!).json()
    const fixture: Context = {
      ...saved,
      candidate: {
        ...saved.candidate,
        request: WorkRouteFixture.candidate(saved.candidate.binding.provider.endpoint).request,
      },
      observed: { counts: [], models: 0, preflights: 0, sourceRefreshes: 0, sourceFreshRequests: [], nearExpiryCreated: 0, observationElapsedMs: 0, trips: [], canceled: 0 },
      state: { mode: "complete", bodies: [], reads: 0, streams: 0 },
    }
    const result = await open(fixture, replay)
    await Bun.write(
      path.join(fixture.root, "cold-result.json"),
      JSON.stringify(
        {
          pid: process.pid,
          file: { path: fixture.filename, inode: (await fs.stat(fixture.filename)).ino },
          observed: fixture.observed,
          result,
        },
        null,
        2,
      ),
    )
  } else {
    const scenario = process.argv[2]
    assert(scenarios.includes(scenario as Scenario))
    await run(scenario as Scenario)
  }
}
