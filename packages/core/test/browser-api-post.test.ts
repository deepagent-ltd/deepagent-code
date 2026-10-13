import { expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { BrowserSchema } from "../src/browser/schema"
import { CanonicalJson } from "../src/util/canonical-json"
import { Hash } from "../src/util/hash"
import { PermissionV2 } from "../src/permission"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../src/database/database"
import { FSUtil } from "../src/fs-util"
import { Location } from "../src/location"
import { LocationIdentity } from "../src/context-federation/identity"
import { SecurityNamespaceTable } from "../src/context-federation/sql"
import { AbsolutePath } from "../src/schema"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { SessionSchema } from "../src/session/schema"
import { SessionTable } from "../src/session/sql"
import { SessionStore } from "../src/session/store"
import { AgentV2 } from "../src/agent"
import { EventV2 } from "../src/event"
import { PermissionSaved } from "../src/permission/saved"
import { BrowserControl } from "../src/browser/control"
import { location } from "./fixture/location"

const command = { type: "api.post", actionTag: BrowserSchema.API_POST_ACTION_TAG, profileVersion: 1,
  tabID: "tab", generation: 2, frameID: "frame", observationRevision: 3,
  url: "https://example.com/api/submit?version=1", contentType: "application/json", body: '{"value":"验证"}',
} satisfies Extract<BrowserSchema.Command, { type: "api.post" }>
const policy = { profile: BrowserSchema.API_POST_PROFILE, origin: "https://example.com",
  approvedOrigins: ["https://example.com", "https://assets.example.com"], resolverPolicy: "system", pageMode: "static",
  apiPostTargets: [{ url: command.url, contentTypes: [command.contentType], maxBodyBytes: 32 }],
} satisfies Pick<Extract<BrowserSchema.Create, { profile: typeof BrowserSchema.API_POST_PROFILE }>,
  "profile" | "origin" | "approvedOrigins" | "resolverPolicy" | "pageMode" | "apiPostTargets">
const control = { ...policy, version: 1, controlID: "control", requestID: "create", requestDigest: "a".repeat(64),
  scope: { principal: "principal", securityNamespaceID: "namespace", locationKey: "location", projectScopeKey: "project-scope",
    namespaceBindingHash: "a".repeat(64), sessionID: "session", projectID: "project", directory: "/private/fixture", workspaceID: null },
  hostID: "host", hostIncarnation: "incarnation", resourceID: "resource", credentialBinding: "a".repeat(64),
  revision: 1, epoch: 1, policyRevision: 1, state: "active", expiresAt: 120000, createdAt: 60000,
  updatedAt: 60000, cancel: null, stopConfirmedAt: null,
} satisfies BrowserSchema.Control

test("API policy requires exact normalized public HTTPS URLs, exact query, main origin and bounded unique targets", () => {
  const decode = Schema.decodeUnknownOption(BrowserSchema.Create, { onExcessProperty: "error" })
  const request = { ...policy, requestID: "create", sessionID: "session", expiresAt: 120000 }
  expect(Option.isSome(decode(request))).toBe(true)
  expect(Option.isSome(decode({ ...request, apiPostTargets: [] }))).toBe(true)
  for (const url of ["http://example.com/api", "https://user:secret@example.com/api", "https://example.com/api#fragment",
    "https://EXAMPLE.com/api", "https://example.com:443/api", "https://example.com/a/../api", "https://example.com/api#",
    "https://127.0.0.1/api", "https://example.com/" + "x".repeat(2048), "https://assets.example.com/api"])
    expect(Option.isNone(decode({ ...request, apiPostTargets: [{ ...policy.apiPostTargets[0], url }] }))).toBe(true)
  for (const apiPostTargets of [
    [...policy.apiPostTargets, ...policy.apiPostTargets],
    Array.from({ length: 9 }, (_, index) => ({ ...policy.apiPostTargets[0], url: `https://example.com/api/${index}` })),
    [{ ...policy.apiPostTargets[0], contentTypes: [] }],
    [{ ...policy.apiPostTargets[0], contentTypes: [command.contentType, command.contentType] }],
    [{ ...policy.apiPostTargets[0], contentTypes: ["multipart/form-data"] }],
    [{ ...policy.apiPostTargets[0], maxBodyBytes: 0 }],
    [{ ...policy.apiPostTargets[0], maxBodyBytes: 65537 }],
  ]) expect(Option.isNone(decode({ ...request, apiPostTargets }))).toBe(true)
  expect(Option.isNone(decode({ ...request, postTargets: [] }))).toBe(true)
})

test("API command requires its independent tag, version and well-formed bounded UTF8 body", () => {
  const decode = Schema.decodeUnknownOption(BrowserSchema.Command, { onExcessProperty: "error" })
  expect(Option.isSome(decode(command))).toBe(true)
  expect(Option.isSome(decode({ ...command, body: "🔥".repeat(16384) }))).toBe(true)
  for (const change of [{ actionTag: "browser-form-post.v1" }, { profileVersion: 2 }, { body: String.fromCharCode(0xd800) },
    { body: "🔥".repeat(16385) }, { headers: { cookie: "private" } }, { url: command.url + "#fragment" }])
    expect(Option.isNone(decode({ ...command, ...change }))).toBe(true)
})

test("API approval matches exact URL and query, content type and target byte ceiling", () => {
  expect(BrowserSchema.allowsApiPost(control, command)).toBe(true)
  expect(BrowserSchema.allowsApiPost({ ...control, apiPostTargets: [] }, command)).toBe(false)
  expect(BrowserSchema.allowsApiPost(control, { ...command, url: command.url.replace("version=1", "version=2") })).toBe(false)
  expect(BrowserSchema.allowsApiPost(control, { ...command, url: command.url + "&extra=1" })).toBe(false)
  expect(BrowserSchema.allowsApiPost(control, { ...command, contentType: "text/plain" })).toBe(false)
  expect(BrowserSchema.allowsApiPost(control, { ...command, body: "验".repeat(11) })).toBe(false)
  expect(BrowserSchema.allowsApiPost(control, { ...command, body: String.fromCharCode(0xd800) })).toBe(false)
  expect(BrowserSchema.allowsApiPost({ ...control, profile: BrowserSchema.PUBLIC_READONLY_PROFILE }, command)).toBe(false)
  expect(BrowserSchema.allowsApiPost({ ...control, profile: BrowserSchema.PUBLIC_INTERACTION_PROFILE, postTargets: [] }, command)).toBe(false)
})

test("API permission metadata binds exact bytes and whole observation command; browser allowance is independent", () => {
  const metadata = BrowserSchema.apiPostMetadata(command)
  expect(metadata).toEqual({ actionTag: "browser-api-post.v1", profileVersion: 1, url: command.url, method: "POST",
    contentType: command.contentType, bodySha256: Hash.sha256(command.body), bodyBytes: Buffer.byteLength(command.body, "utf8"),
    commandHash: Hash.sha256(CanonicalJson.stringify(command)) })
  expect(JSON.stringify(metadata)).not.toContain(command.body)
  for (const changed of [{ ...command, body: '{ "value":"验证"}' }, { ...command, url: command.url.replace("version=1", "version=2") },
    { ...command, frameID: "other-frame" }, { ...command, observationRevision: 4 }])
    expect(BrowserSchema.apiPostMetadata(changed).commandHash).not.toBe(metadata.commandHash)
  const rules = [{ action: "browser", resource: "*", effect: "allow" }] satisfies PermissionV2.Ruleset
  expect(PermissionV2.evaluate("browser", "control/api.post/tab/hash", rules).effect).toBe("allow")
  expect(PermissionV2.evaluate("browser-api-post", "control/api.post/tab/hash", rules).effect).toBe("ask")
})

test("API result is bounded and digest-consistent and cannot be attached to another command or a redirect", () => {
  const text = '{"ok":true}'
  const result = { tabs: [], apiPost: { version: 1, status: 200, contentType: "application/json",
    bytes: Buffer.byteLength(text), sha256: Hash.sha256(text), text } } satisfies BrowserSchema.Result
  const decode = Schema.decodeUnknownOption(BrowserSchema.Result, { onExcessProperty: "error" })
  expect(Option.isSome(decode(result))).toBe(true)
  expect(BrowserSchema.matchesApiPostResult(command, result)).toBe(true)
  expect(BrowserSchema.matchesApiPostResult(command, { tabs: [] })).toBe(false)
  expect(BrowserSchema.matchesApiPostResult({ type: "tabs.list" }, result)).toBe(false)
  for (const status of [301, 302, 303, 307, 308])
    expect(BrowserSchema.matchesApiPostResult(command, { ...result, apiPost: { ...result.apiPost, status } })).toBe(false)
  for (const change of [{ version: 2 }, { status: 99 }, { status: 600 }, { bytes: 65537 }, { bytes: 1 },
    { sha256: "a".repeat(64) }, { text: String.fromCharCode(0xd800) }, { text: "🔥".repeat(16385) }, { contentType: "a".repeat(257) }])
    expect(Option.isNone(decode({ ...result, apiPost: { ...result.apiPost, ...change } }))).toBe(true)
})

test("old public profiles retain exact decoded field bytes and reject API policy fields", () => {
  const decode = Schema.decodeUnknownOption(BrowserSchema.Create, { onExcessProperty: "error" })
  for (const request of [
    { requestID: "old-readonly", sessionID: "session", expiresAt: 120000, profile: BrowserSchema.PUBLIC_READONLY_PROFILE,
      origin: policy.origin, approvedOrigins: policy.approvedOrigins, resolverPolicy: policy.resolverPolicy },
    { requestID: "old-interaction", sessionID: "session", expiresAt: 120000, profile: BrowserSchema.PUBLIC_INTERACTION_PROFILE,
      origin: policy.origin, approvedOrigins: policy.approvedOrigins, resolverPolicy: policy.resolverPolicy,
      pageMode: policy.pageMode, postTargets: [{ origin: policy.origin, path: "/submit" }] },
  ]) {
    const decoded = Schema.decodeUnknownSync(BrowserSchema.Create, { onExcessProperty: "error" })(request)
    expect(CanonicalJson.stringify(decoded)).toBe(CanonicalJson.stringify(request))
    expect(Option.isNone(decode({ ...request, apiPostTargets: policy.apiPostTargets }))).toBe(true)
  }
})

test("real file DB retains API actions across retries and cold reads with controlled admissions and two real permissions", async () => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-browser-api-post-store-"))
  const file = path.join(root, "browser.sqlite")
  const database = Database.layerFromPath(file)
  const dependencies = Layer.mergeAll(database, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(root) })),
    EventV2.layer.pipe(Layer.provide(database)), SessionStore.layer.pipe(Layer.provide(database)),
    PermissionSaved.layer.pipe(Layer.provide(database)), LocationIdentity.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer)))
  const layer = PermissionV2.locationLayer.pipe(Layer.provideMerge(dependencies))
  const census = Effect.gen(function* () {
    const db = (yield* Database.Service).db
    return { controls: yield* db.all("SELECT * FROM browser_control ORDER BY control_id"),
      actions: yield* db.all("SELECT * FROM browser_action ORDER BY action_id") }
  })
  try {
    const retained = await Effect.runPromise(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const sessionID = SessionSchema.ID.make("ses_api_post_store")
      yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make(root), sandboxes: [] }).onConflictDoNothing().run()
      yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, directory: root,
        slug: "api-post", title: "API controlled admission", version: "fixture", agent: "test", v2_authority: true }).run()
      const identity = yield* (yield* LocationIdentity.Service).resolve({ boundary: { kind: "implicit_local" },
        directory: AbsolutePath.make(root), project: { kind: "registered_root", observedProjectId: "project_api_post_root" } })
      const namespace = yield* db.select().from(SecurityNamespaceTable).where(eq(SecurityNamespaceTable.id, identity.securityNamespaceId)).get()
      expect(namespace).toBeDefined()
      if (!namespace) return yield* Effect.fail(new Error("Private namespace fixture was not created"))
      const scope = { principal: "operator", securityNamespaceID: identity.securityNamespaceId,
        namespaceBindingHash: namespace.binding_hash, locationKey: identity.locationKey, projectScopeKey: identity.projectScopeKey,
        projectID: Project.ID.global, sessionID, directory: identity.canonicalRoot, workspaceID: null } satisfies BrowserSchema.Scope
      const input = { request: { ...policy, requestID: "api-create", sessionID, expiresAt: Date.now() + 60000 }, scope,
        hostID: "host", hostIncarnation: "incarnation", credentialBinding: "a".repeat(64) } satisfies Parameters<typeof BrowserControl.create>[1]
      const created = yield* BrowserControl.create(db, input)
      const active = yield* BrowserControl.observeControl(db, created.record, "active")
      expect(active.profile).toBe(BrowserSchema.API_POST_PROFILE)
      if (active.profile !== BrowserSchema.API_POST_PROFILE) return yield* Effect.fail(new Error("API policy was not retained"))
      expect(active.apiPostTargets).toEqual(policy.apiPostTargets)
      const beforeRetry = yield* census
      expect((yield* BrowserControl.create(db, input)).created).toBe(false)
      expect(yield* census).toEqual(beforeRetry)
      expect(Exit.isFailure(yield* BrowserControl.create(db, { ...input, request: { ...input.request,
        apiPostTargets: [{ ...policy.apiPostTargets[0], maxBodyBytes: 33 }] } }).pipe(Effect.exit))).toBe(true)

      // This is the original store's controlled-admission fixture, not a canonical provider turn or Native execution.
      const admission = (suffix: string) => ({ admissionId: `api-admission-${suffix}`, sessionId: sessionID, providerAttemptId: "controlled-attempt",
        receiptId: "controlled-receipt", toolCallId: `api-call-${suffix}`, toolName: "browser", effectKind: "mutating", ownerToken: "controlled-owner",
        timeCreated: Date.now() } satisfies Parameters<typeof BrowserControl.prepareAction>[1]["admission"])
      const completedInput = { control: active, command, admission: admission("completed"), timeoutMs: 10000 }
      const pending = yield* BrowserControl.prepareAction(db, completedInput, () => Effect.void)
      const valid = { tabs: [], apiPost: { version: 1, status: 200, contentType: "application/json", text: "{}",
        bytes: 2, sha256: Hash.sha256("{}") } } satisfies BrowserSchema.Result
      const beforeInvalid = yield* census
      for (const result of [{ tabs: [] }, { ...valid, apiPost: { ...valid.apiPost, status: 307 } },
        { ...valid, apiPost: { ...valid.apiPost, sha256: "a".repeat(64) } }])
        expect(Exit.isFailure(yield* BrowserControl.observeAction(db, pending, { outcome: "completed", result }).pipe(Effect.exit))).toBe(true)
      expect(yield* census).toEqual(beforeInvalid)
      const completed = yield* BrowserControl.observeAction(db, pending, { outcome: "completed", result: valid })
      const unknownInput = { control: active, command: { ...command, generation: 3 }, admission: admission("unknown"), timeoutMs: 10000 }
      const running = yield* BrowserControl.prepareAction(db, unknownInput, () => Effect.void)
      const unknown = yield* BrowserControl.observeAction(db, running, { outcome: "unknown", errorCode: "BROWSER_UNKNOWN" })
      const settled = yield* census
      for (const retry of [{ input: completedInput, code: "BROWSER_CONFLICT" }, { input: unknownInput, code: "BROWSER_UNKNOWN" }] satisfies
        { input: Parameters<typeof BrowserControl.prepareAction>[1]; code: BrowserSchema.Error["code"] }[]) {
        const exit = yield* BrowserControl.prepareAction(db, retry.input, () => Effect.void).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))?.code).toBe(retry.code)
      }
      expect(yield* census).toEqual(settled)
      for (const request of [
        { requestID: "old-readonly", sessionID, expiresAt: input.request.expiresAt, profile: BrowserSchema.PUBLIC_READONLY_PROFILE,
          origin: policy.origin, approvedOrigins: policy.approvedOrigins, resolverPolicy: policy.resolverPolicy },
        { requestID: "old-interaction", sessionID, expiresAt: input.request.expiresAt, profile: BrowserSchema.PUBLIC_INTERACTION_PROFILE,
          origin: policy.origin, approvedOrigins: policy.approvedOrigins, resolverPolicy: policy.resolverPolicy, pageMode: policy.pageMode, postTargets: [] },
      ] satisfies BrowserSchema.Create[]) {
        const old = yield* BrowserControl.create(db, { ...input, request })
        const oldActive = yield* BrowserControl.observeControl(db, old.record, "active")
        const before = yield* census
        const rejected = yield* BrowserControl.prepareAction(db, { control: oldActive, command,
          admission: admission(request.requestID), timeoutMs: 10000 }, () => Effect.void).pipe(Effect.exit)
        expect(Exit.isFailure(rejected)).toBe(true)
        if (Exit.isFailure(rejected)) expect(Option.getOrUndefined(Cause.findErrorOption(rejected.cause))?.code).toBe("BROWSER_SCOPE_DENIED")
        expect(yield* census).toEqual(before)
      }

      const transform = yield* (yield* AgentV2.Service).transform()
      yield* transform((editor) => editor.update(AgentV2.ID.make("test"), (agent) => { agent.permissions = [] }))
      const permissions = yield* PermissionV2.Service
      const events = yield* EventV2.Service
      const permits = yield* Effect.forEach(["browser", "browser-api-post"], (action) => Effect.gen(function* () {
        const asked = yield* Deferred.make<PermissionV2.Request>()
        const unsubscribe = yield* events.listen((event) => {
          if (event.type !== PermissionV2.Event.Asked.type) return Effect.void
          const request = Schema.decodeUnknownSync(PermissionV2.Request)(event.data)
          return request.action === action ? Deferred.succeed(asked, request).pipe(Effect.asVoid) : Effect.void
        })
        yield* Effect.addFinalizer(() => unsubscribe)
        const request = { sessionID, agent: AgentV2.ID.make("test"), action,
          resources: [`${active.controlID}/api.post/${command.tabID}/${BrowserControl.hash(command)}`],
          metadata: { origin: active.origin, operation: command.type, controlID: active.controlID, ...BrowserSchema.apiPostMetadata(command) },
          source: { type: "tool", messageID: "controlled-assistant", callID: "controlled-call" },
        } satisfies PermissionV2.AssertInput
        if (!permissions.authorizeAction || !permissions.checkAction) return yield* Effect.fail(new Error("Real permits are unavailable"))
        const waiting = yield* permissions.authorizeAction(request).pipe(Effect.forkScoped)
        const actual = yield* Deferred.await(asked)
        expect(actual.action).toBe(action)
        expect(actual.metadata).toEqual(request.metadata)
        expect(actual.source).toEqual(request.source)
        yield* permissions.reply({ requestID: actual.id, reply: "once" })
        const permit = yield* Fiber.join(waiting)
        yield* permissions.checkAction(permit, request)
        expect(Exit.isFailure(yield* permissions.checkAction(permit, { ...request,
          metadata: { ...request.metadata, bodySha256: Hash.sha256("changed body") } }).pipe(Effect.exit))).toBe(true)
        return { permit, request }
      }))
      if (!permissions.checkAction || !permits[0] || !permits[1]) return yield* Effect.fail(new Error("Both permits were not captured"))
      expect(Exit.isFailure(yield* permissions.checkAction(permits[0].permit, permits[1].request).pipe(Effect.exit))).toBe(true)
      yield* transform((editor) => editor.update(AgentV2.ID.make("test"), (agent) => {
        agent.permissions = [{ action: "browser-api-post", resource: "*", effect: "deny" }]
      }))
      expect(Exit.isFailure(yield* permissions.checkAction(permits[1].permit, permits[1].request).pipe(Effect.exit))).toBe(true)
      expect(yield* permissions.list()).toEqual([])
      return { active, completed, unknown, census: yield* census }
    }).pipe(Effect.provide(layer), Effect.scoped))
    await Effect.runPromise(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const before = yield* census
      expect(yield* BrowserControl.get(db, retained.active.controlID)).toEqual(retained.active)
      expect(yield* BrowserControl.getAction(db, retained.completed.actionID)).toEqual(retained.completed)
      expect(yield* BrowserControl.getAction(db, retained.unknown.actionID)).toEqual(retained.unknown)
      expect((yield* BrowserControl.actionView(db, retained.unknown, retained.active)).observedOutcome).toBe("unknown")
      expect((yield* BrowserControl.actionView(db, retained.completed, retained.active)).nativeVerification).toBe("unavailable")
      expect(yield* census).toEqual(before)
      expect(yield* census).toEqual(retained.census)
    }).pipe(Effect.provide(Database.layerFromPath(file)), Effect.scoped))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30000)
