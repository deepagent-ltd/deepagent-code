import { tmpdir } from "node:os"
export * as BrowserFileAuthorityFixture from "./browser-file-authority"

import fs from "node:fs/promises"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Effect, Exit, Layer, Scope } from "effect"
import { AgentV2 } from "../../src/agent"
import { BrowserControl } from "../../src/browser/control"
import { BrowserSchema } from "../../src/browser/schema"
import { BrowserFileAuthority } from "../../src/browser/file-authority"
import { LocationIdentity } from "../../src/context-federation/identity"
import { SecurityNamespaceTable } from "../../src/context-federation/sql"
import { SessionContext } from "../../src/context-federation/session-context"
import { SessionProviderOwner } from "../../src/context-federation/provider-owner"
import { Database } from "../../src/database/database"
import { EventV2 } from "../../src/event"
import { FSUtil } from "../../src/fs-util"
import { Location } from "../../src/location"
import { PermissionV2 } from "../../src/permission"
import { PermissionSaved } from "../../src/permission/saved"
import { AbsolutePath } from "../../src/schema"
import { SessionV2 } from "../../src/session"
import { SessionExecution } from "../../src/session/execution"
import { SessionInput } from "../../src/session/input"
import { SessionMessage } from "../../src/session/message"
import { Prompt } from "../../src/session/prompt"
import { SessionProjector } from "../../src/session/projector"
import { SessionStore } from "../../src/session/store"
import { SessionRunnerCanonical } from "../../src/session/runner/canonical-turn"
import { CurrentToolExecution } from "../../src/session/runner/current-tool-execution"
import { V2ProviderTurn } from "../../src/session/runner/v2-provider-turn"
import { V2ToolEffect } from "../../src/session/runner/v2-tool-effect"
import { Hash } from "../../src/util/hash"
import { location } from "./location"
import { projectLayer } from "./project-layer"

type Services = Database.Service | AgentV2.Service | PermissionV2.Service | PermissionSaved.Service | SessionV2.Service |
  SessionStore.Service | EventV2.Service | SessionProviderOwner.Service | V2ProviderTurn.Service | V2ToolEffect.Service | Scope.Scope

export async function isolated<A, E>(body: (fixture: Fixture) => Effect.Effect<A, E, Services>, options: { leaseMs?: number } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "dac-browser-file-authority-")))
  const runtimeLocation = location({ directory: AbsolutePath.make(directory) })
  const database = Database.layerFromPath(path.join(directory, "authority.sqlite"))
  const events = EventV2.layer.pipe(Layer.provide(database))
  const store = SessionStore.layer.pipe(Layer.provide(database))
  const agents = AgentV2.layer
  const saved = PermissionSaved.layer.pipe(Layer.provide(database))
  const dependencies = Layer.mergeAll(database, events, store, agents, saved, Layer.succeed(Location.Service, runtimeLocation))
  const permission = PermissionV2.layer.pipe(Layer.provide(dependencies))
  const sessions = SessionV2.layer.pipe(Layer.provide(Layer.mergeAll(dependencies, SessionExecution.noopLayer, projectLayer(database))))
  const projector = SessionProjector.layer.pipe(Layer.provide(Layer.mergeAll(database, events)))
  const owners = SessionProviderOwner.layer.pipe(Layer.provide(database))
  const turns = V2ProviderTurn.layerWith(options).pipe(Layer.provide(Layer.mergeAll(database, owners)))
  const effects = V2ToolEffect.layer.pipe(Layer.provide(database))
  const contexts = SessionContext.layer.pipe(Layer.provide(Layer.mergeAll(database, SessionRunnerCanonical.degradedArtifactStore)))
  const identities = LocationIdentity.layer.pipe(Layer.provide(Layer.mergeAll(database, FSUtil.defaultLayer)))
  const layer = Layer.mergeAll(dependencies, permission, sessions, projector, owners, turns, effects, contexts, identities)
  try {
    return await Effect.runPromise(prepare(runtimeLocation).pipe(Effect.flatMap(body), Effect.provide(layer), Effect.scoped))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

/** Original Session admission, promotion, claim, selection, commit, wire seal, streaming
 * transition and tool admission. There is no model request, native host or forged authority row. */
const prepare = Effect.fn("BrowserFileAuthorityFixture.prepare")(function* (runtimeLocation: Location.Interface) {
  const db = (yield* Database.Service).db
  const agents = yield* AgentV2.Service
  const editor = yield* agents.transform()
  yield* editor((state) => state.update(AgentV2.ID.make("test"), (agent) => {
    agent.permissions = [{ action: "browser", resource: "*", effect: "allow" }, { action: "browser-file", resource: "*", effect: "allow" }]
  }))
  const sessions = yield* SessionV2.Service
  const session = yield* sessions.create({ location: { directory: runtimeLocation.directory }, agent: AgentV2.ID.make("test"), title: "file authority fixture" })
  const prompted = yield* sessions.prompt({ sessionID: session.id, prompt: new Prompt({ text: "Controlled file authority fixture" }), delivery: "queue", resume: false })
  yield* SessionInput.promoteNextQueued(db, yield* EventV2.Service, session.id)
  const claim = yield* (yield* SessionStore.Service).claim(session.id)
  if (!claim) return yield* Effect.die(new Error("fixture did not acquire the original Session claim"))
  const identity = yield* (yield* LocationIdentity.Service).resolve({ boundary: { kind: "implicit_local" },
    directory: runtimeLocation.directory, project: { kind: "registered_root", observedProjectId: session.projectID } })
  const selection = yield* SessionRunnerCanonical.admitSelection({ db, contexts: yield* SessionContext.Service,
    sessionID: session.id, agent: "test", location: { directory: runtimeLocation.directory }, promotedInputIds: [prompted.id],
    system: { baseline: "controlled fixture", revision: 0, baselineSeq: 1 }, historyEndMessageId: prompted.id,
    sources: { identity: { securityNamespaceId: identity.securityNamespaceId, locationKey: identity.locationKey,
      projectScopeKey: identity.projectScopeKey, legacyProjectId: session.projectID } } })
  const turns = yield* V2ProviderTurn.Service
  const committed = yield* SessionRunnerCanonical.commitTurn({ db, contexts: yield* SessionContext.Service, sessionID: session.id,
    admission: selection, ownerToken: yield* turns.currentOwnerToken(), receipt: { sessionId: session.id, userMessageId: prompted.id,
      historyPromptEpoch: 0, historySourceEndMessageId: prompted.id, requestInputHash: Hash.sha256("fixture request"),
      providerId: "fixture", modelId: "fixture", protocol: "openai-chat", ownerMode: "v2" } })
  const wire = "controlled fixture wire"
  const prepared = V2ProviderTurn.prepare({ receipt: committed.receipt, stableSystemParts: [], volatileSystemParts: [],
    historyMessages: [], toolDefinitions: [], toolIDs: ["browser"], toolChoice: null, toolResultReferences: [],
    budget: { decision: "ok", estimatedFullRequestTokens: 1, physicalInputBudget: 1000, reservedOutputTokens: 10, safetyMargin: 0, provenance: "model_limit" },
    userMessageID: prompted.id, activityID: committed.receipt.activityId, providerTurnSeq: committed.receipt.providerTurnSeq,
    contextSelectionID: selection.selectionId, contextProjectionHash: selection.projectionHash }, Hash.sha256(wire))
  const receipt = yield* turns.markStreaming(yield* turns.seal(committed.receipt, prepared,
    { wireHash: Hash.sha256(wire), bodyHash: Hash.sha256(wire), bodyLength: Buffer.byteLength(wire), bodyText: wire, contentType: "application/json" }))
  const admission = yield* (yield* V2ToolEffect.Service).admit({ sessionId: session.id, providerAttemptId: committed.attempt.attemptId,
    receiptId: receipt.receiptId, toolCallId: "call_file_authority", toolName: "browser", effectKind: "mutating", ownerToken: receipt.ownerToken, now: Date.now() })
  const namespace = yield* db.select({ binding_hash: SecurityNamespaceTable.binding_hash }).from(SecurityNamespaceTable)
    .where(eq(SecurityNamespaceTable.id, identity.securityNamespaceId)).get()
  if (!namespace) return yield* Effect.die(new Error("fixture namespace was not created"))
  const scope: BrowserSchema.Scope = { principal: "fixture-operator", securityNamespaceID: identity.securityNamespaceId,
    namespaceBindingHash: namespace.binding_hash, locationKey: identity.locationKey, projectScopeKey: identity.projectScopeKey,
    sessionID: session.id, projectID: session.projectID, directory: runtimeLocation.directory, workspaceID: null }
  const descriptor = { hostID: "fixture-host", hostIncarnation: "fixture-incarnation", credentialBinding: "a".repeat(64) }
  const created = yield* BrowserControl.create(db, { request: { requestID: "fixture-create", sessionID: session.id,
    origin: "http://127.0.0.1:34567", expiresAt: Date.now() + 60_000, profile: BrowserSchema.FILE_EXCHANGE_PROFILE, postPaths: ["/upload"],
    filePolicy: { upload: true, download: true } }, scope, ...descriptor })
  const control = yield* BrowserControl.observeControl(db, created.record, "active")
  const hostState = { alive: true, matched: true }
  const host = { ...descriptor, alive: () => hostState.alive,
    verify: (_control: BrowserSchema.Control) => ({ matched: hostState.matched, stopped: false }) }
  const input: BrowserSchema.Invoke = { controlID: control.controlID,
    command: { type: "file.upload", tabID: "tab_fixture", generation: 1, frameID: "frame_fixture", observationRevision: 1, ref: "ref_fixture", grantIDs: ["grant_fixture"] } }
  const context = { sessionID: session.id, agent: AgentV2.ID.make("test"), assistantMessageID: SessionMessage.ID.make("msg_assistant"), toolCallID: admission.toolCallId }
  const permission = yield* PermissionV2.Service
  const authorizationScope = yield* Scope.make()
  yield* Effect.addFinalizer(() => Scope.close(authorizationScope, Exit.void))
  const request: PermissionV2.AssertInput = { sessionID: session.id, agent: context.agent, action: "browser",
    resources: [`${control.controlID}/file.upload/${BrowserControl.hash(input.command)}`],
    source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID } }
  const fileRequest = { ...request, action: "browser-file" }
  const browser = { input: request, permit: yield* permission.authorizeAction!(request).pipe(Effect.provideService(Scope.Scope, authorizationScope)) }
  const file = { input: fileRequest, permit: yield* permission.authorizeAction!(fileRequest).pipe(Effect.provideService(Scope.Scope, authorizationScope)) }
  const captureInput = { context, location: { ...runtimeLocation, project: { ...runtimeLocation.project, id: session.projectID } },
    input, control, host, permission, browser, file }
  return { db, session, claim, receipt, admission, turns, hostState, authorizationScope, captureInput,
    capture: () => BrowserFileAuthority.capture(db, captureInput),
    frame: <A, E, R>(body: Effect.Effect<A, E, R>) => CurrentToolExecution.withAdmission(db,
      { admission, context, location: captureInput.location, input, provider: turns }, body) }
})
export type Fixture = Effect.Success<ReturnType<typeof prepare>>
