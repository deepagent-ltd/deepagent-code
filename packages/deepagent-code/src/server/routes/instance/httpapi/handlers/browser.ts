import { timingSafeEqual } from "node:crypto"
import { eq } from "drizzle-orm"
import { Cause, Effect, Option, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerRequest } from "effect/unstable/http"
import { BrowserControl } from "@deepagent-code/core/browser/control"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { SharedBrowserTuiSchema } from "@deepagent-code/core/browser/shared-tui-schema"
import { SharedBrowserSchema } from "@deepagent-code/core/browser/shared-schema"
import { SharedBrowserFileSchema } from "@deepagent-code/core/browser/shared-file-schema"
import { SharedBrowserFileBinding } from "@deepagent-code/core/browser/shared-file-binding"
import { SharedBrowserFileExchange } from "@deepagent-code/core/browser/shared-file-exchange"
import { SharedBrowserControl } from "@deepagent-code/core/browser/shared-control"
import { BrowserFileSchema } from "@deepagent-code/core/browser/file-exchange.schema"
import { BrowserFiles } from "@/browser/file-exchange"
import { Database } from "@deepagent-code/core/database/database"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { SecurityNamespaceTable } from "@deepagent-code/core/context-federation/sql"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { ProjectV2 } from "@deepagent-code/core/project"
import { Project } from "@/project/project"
import { BrowserNativeHost } from "@/browser/native-host"
import { resolveBrowserLocation, scopeDenied } from "@/browser/location-binding"
import { ServerAuth } from "@/server/auth"
import { CorsConfig } from "@/server/cors"
import { BrowserHttpApi } from "../api"
import { BrowserForbidden, BrowserMissing, BrowserConflict, BrowserUnavailable } from "../groups/browser"
import { browserTui } from "./browser-tui"

export const browserHandlers = () => HttpApiBuilder.group(BrowserHttpApi, "browser", (handlers) => Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const config = yield* ServerAuth.Config
  const cors = yield* CorsConfig
  const identity = yield* LocationIdentity.Service
  const projects = yield* Project.Service
  const projectResolver = yield* ProjectV2.Service
  const files = yield* BrowserFiles.Service
  BrowserNativeHost.captureServerConfiguration(config)
  const host = BrowserNativeHost.current()
  const authenticate = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (!ServerAuth.required(config) || Option.isNone(config.password)) return yield* BrowserControl.failure("BROWSER_AUTHORITY_REQUIRED")
    const value = request.headers.authorization
    if (!value?.startsWith("Basic ") || value.length > 8192 || new URL(request.originalUrl, "http://localhost").searchParams.has("auth_token"))
      return yield* BrowserControl.failure("BROWSER_AUTHORITY_REQUIRED")
    const wanted = Buffer.from(`Basic ${Buffer.from(`${config.username}:${config.password.value}`).toString("base64")}`)
    const actual = Buffer.from(value)
    if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return yield* BrowserControl.failure("BROWSER_AUTHORITY_REQUIRED")
    return { username: config.username, password: config.password.value }
  })
  const native = (destroyOnly = false) => Effect.gen(function* () {
    const credentials = yield* authenticate
    const request = yield* HttpServerRequest.HttpServerRequest
    const socket = "socket" in request.source ? request.source.socket : undefined
    if (!socket || typeof socket !== "object" || !("localAddress" in socket) || !("remoteAddress" in socket) ||
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(String(socket.localAddress)) ||
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(String(socket.remoteAddress)))
      return yield* scopeDenied("native_transport")
    const origin = request.headers.origin
    if (origin && origin !== "oc://renderer" && !cors?.cors?.includes(origin)) {
      if (!URL.canParse(origin)) return yield* scopeDenied("native_origin")
      const url = new URL(origin)
      if (url.origin !== origin || url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
        !("localPort" in socket) || Number(url.port || 80) !== socket.localPort)
        return yield* scopeDenied("native_origin")
    }
    if (!host?.alive() || host.principal !== credentials.username ||
      (!destroyOnly && !host.matchesCredentials(credentials.username, credentials.password)))
      return yield* BrowserControl.failure("BROWSER_HOST_UNAVAILABLE")
    return host
  })
  const read = (controlID: string) => Effect.gen(function* () {
    const credentials = yield* authenticate
    const control = yield* BrowserControl.get(db, controlID)
    if (!control) return yield* BrowserControl.failure("BROWSER_NOT_FOUND")
    if (control.scope.principal !== credentials.username) return yield* BrowserControl.failure("BROWSER_SCOPE_DENIED")
    yield* BrowserControl.requireScope(db, control.scope)
    return control
  })
  const readShared = (resourceID: string) => Effect.gen(function* () {
    const credentials = yield* authenticate
    const resource = yield* SharedBrowserControl.get(db, resourceID)
    if (!resource) return yield* BrowserControl.failure("BROWSER_NOT_FOUND")
    if (resource.scope.principal !== credentials.username) return yield* BrowserControl.failure("BROWSER_SCOPE_DENIED")
    yield* BrowserControl.requireScope(db, resource.scope)
    return resource
  })
  const sharedFileReady = (resource: SharedBrowserSchema.Resource) => Effect.gen(function* () {
    const nativeHost = yield* native()
    const driver = nativeHost.shared?.files
    if (!driver?.ready) return yield* BrowserControl.failure("BROWSER_DRIVER_UNAVAILABLE")
    const active = yield* SharedBrowserControl.requireActive(db, resource.resourceID, resource.scope)
    if (SharedBrowserControl.hash(active.resource) !== SharedBrowserControl.hash(resource) ||
      resource.mainIncarnation !== nativeHost.shared?.mainIncarnation || active.lease.sidecarIncarnation !== nativeHost.hostIncarnation)
      return yield* BrowserControl.failure("BROWSER_STALE_TARGET")
    if (!(yield* driver.ready(active.resource, active.lease))) return yield* BrowserControl.failure("BROWSER_DRIVER_UNAVAILABLE")
    return { ...active, driver }
  })
  const strictBody = <A>(schema: Schema.Decoder<A>) => Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const body = yield* request.json.pipe(Effect.mapError(() => new BrowserFileSchema.Error({ code: "BROWSER_FILE_INVALID", message: "Invalid browser file request" })))
    const parsed = Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(body)
    if (Option.isNone(parsed)) return yield* new BrowserFileSchema.Error({ code: "BROWSER_FILE_INVALID", message: "Invalid browser file request" })
    return parsed.value
  })
  const scopeFor = (sessionID: string) => Effect.gen(function* () {
    const record = yield* db.select().from(SessionTable).where(eq(SessionTable.id, SessionSchema.ID.make(sessionID)))
      .get().pipe(Effect.mapError(() => BrowserControl.failure("BROWSER_UNAVAILABLE")))
    if (!record) return yield* BrowserControl.failure("BROWSER_NOT_FOUND")
    if (record.workspace_id !== null || !record.v2_authority) return yield* scopeDenied("session_placement")
    const observed = yield* projects.observeDirectory(record.directory).pipe(Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : scopeDenied("project_observation")))
    const actual = yield* projectResolver.resolve(AbsolutePath.make(observed.directory)).pipe(Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : scopeDenied("project_resolution")))
    if (!observed.project || observed.directory !== record.directory || observed.project.id !== record.project_id ||
      actual.id !== observed.project.id || actual.vcs?.type !== observed.project.vcs)
      return yield* scopeDenied("project_current")
    const resolved = yield* resolveBrowserLocation({ identity, directory: AbsolutePath.make(observed.directory),
      projectID: actual.id, git: actual.vcs?.type === "git" })
    const namespace = yield* db.select().from(SecurityNamespaceTable).where(eq(SecurityNamespaceTable.id, resolved.securityNamespaceId))
      .get().pipe(Effect.mapError(() => BrowserControl.failure("BROWSER_UNAVAILABLE")))
    if (!namespace) return yield* scopeDenied("namespace_current")
    return { principal: config.username, securityNamespaceID: resolved.securityNamespaceId,
      locationKey: resolved.locationKey, projectScopeKey: resolved.projectScopeKey, namespaceBindingHash: namespace.binding_hash,
      sessionID: record.id, projectID: record.project_id, directory: resolved.canonicalRoot, workspaceID: null } satisfies BrowserSchema.Scope
  })
  const view = (control: BrowserSchema.Control): typeof BrowserSchema.ControlView.Type => {
    const verification = host?.verify(control)
    const matched = verification?.matched === true && (verification.stopped ||
      (Option.isSome(config.password) && host?.matchesCredentials(config.username, config.password.value) === true))
    return { control, nativeVerification: matched ? "verified" : "unavailable",
      stopConfirmed: matched && verification?.stopped === true,
      availability: !matched ? "host_unavailable" : verification?.stopped ? "stopped" :
        control.expiresAt <= Date.now() ? "expired" : "available" }
  }
  const tui = browserTui(native, scopeFor)
  return handlers
    .handle("tuiPair", ({ payload }) => mapped(tui.pair(payload)))
    .handleRaw("tuiOwner", ({ request }) => mapped(Effect.gen(function* () {
      const body = yield* request.json.pipe(Effect.mapError(() => BrowserControl.failure("BROWSER_SCOPE_DENIED")))
      const input = Schema.decodeUnknownOption(SharedBrowserTuiSchema.Connect, { onExcessProperty: "error" })(body)
      if (Option.isNone(input)) return yield* BrowserControl.failure("BROWSER_SCOPE_DENIED")
      return yield* tui.owner(input.value)
    })))
        .handle("tuiReserve", ({ payload }) => mapped(tui.reserve(payload)))
        .handle("tuiSeal", ({ payload }) => mapped(tui.seal(payload)))
        .handle("tuiDetach", ({ payload }) => mapped(tui.detach(payload)))
        .handle("sharedCreate", ({ payload }) => mapped(Effect.gen(function* () {
      const nativeHost = yield* native()
      if (!nativeHost.shared) return yield* BrowserControl.failure("BROWSER_DRIVER_UNAVAILABLE")
      const created = yield* SharedBrowserControl.create(db, { request: payload, scope: yield* scopeFor(payload.sessionID),
        mainIncarnation: nativeHost.shared.mainIncarnation, sidecarIncarnation: nativeHost.hostIncarnation })
      if (created.resource.state !== "creating") {
        yield* nativeHost.shared.syncProjection(created.resource)
        return { resource: created.resource }
      }
      const observation = yield* nativeHost.shared.create(created.resource, created.lease)
      const resource = yield* SharedBrowserControl.observeCreated(db, created.resource, observation)
      yield* nativeHost.shared.syncProjection(resource)
      return { resource }
    })))
    .handle("sharedList", ({ query }) => mapped(Effect.gen(function* () {
      yield* native()
      return { resources: yield* SharedBrowserControl.list(db, yield* scopeFor(query.sessionID)).pipe(
        Effect.mapError((error) => error instanceof BrowserSchema.Error ? error : BrowserControl.failure("BROWSER_UNAVAILABLE"))) }
    })))
    .handle("sharedGet", ({ params }) => mapped(readShared(params.resourceID).pipe(Effect.map((resource) => ({ resource })))))
    .handle("sharedTakeover", ({ params, payload }) => mapped(Effect.gen(function* () {
      const nativeHost = yield* native(true)
      if (!nativeHost.shared || payload.resourceID !== params.resourceID) return yield* BrowserControl.failure("BROWSER_SCOPE_DENIED")
      const resource = yield* readShared(params.resourceID)
      const ticket = yield* nativeHost.shared.takeover(resource, payload)
      const recorded = yield* SharedBrowserControl.recordBarrier(db, ticket)
      if (recorded.receipt?.state === "completed") return { resource: recorded.resource }
      const observation = yield* nativeHost.shared.confirmBarrier(recorded.resource, ticket)
      const settled = yield* SharedBrowserControl.observeBarrier(db, ticket, observation)
      yield* nativeHost.shared.syncProjection(settled)
      return { resource: settled }
    })))
    .handle("sharedApproveOrigin", ({ params }) => mapped(Effect.gen(function* () {
      const payload = yield* strictBody(SharedBrowserSchema.ApproveOrigin)
      if (payload.resourceID !== params.resourceID) return yield* BrowserControl.failure("BROWSER_SCOPE_DENIED")
      const resource = yield* readShared(params.resourceID)
      const driver = (yield* native()).shared?.policy
      if (!driver) return yield* BrowserControl.failure("BROWSER_DRIVER_UNAVAILABLE")
      const prior = resource.policyApprovals?.find((receipt) => receipt.requestID === payload.requestID)
      if (prior) {
        if (prior.requestHash !== SharedBrowserControl.hash(payload) || resource.manualEpoch !== payload.expectedManualEpoch)
          return yield* BrowserControl.failure("BROWSER_CONFLICT")
        yield* driver.commit(resource, payload)
        return { resource }
      }
      const claim = yield* driver.claim(resource, payload)
      const updated = yield* SharedBrowserControl.approveOrigin(db, resource, payload,
        () => driver.check(resource, payload, claim)).pipe(Effect.catch((error) => Effect.gen(function* () {
          // Only a known rolled-back denial may release this unique claim. A lost
          // callback, interruption or storage outcome retains its original slot.
          if (["BROWSER_CONFLICT", "BROWSER_SCOPE_DENIED", "BROWSER_CAPACITY", "BROWSER_INVALID_RECORD", "BROWSER_EXPIRED"].includes(error.code))
            yield* driver.abort(resource, payload, claim).pipe(Effect.catch(() => Effect.void))
          return yield* error
        })))
      yield* driver.commit(updated, payload)
      return { resource: updated }
    })))
    .handle("sharedClose", ({ params, payload }) => mapped(Effect.gen(function* () {
      const nativeHost = yield* native(true)
      if (!nativeHost.shared || payload.resourceID !== params.resourceID) return yield* BrowserControl.failure("BROWSER_SCOPE_DENIED")
      const prepared = yield* SharedBrowserControl.prepareClose(db, yield* readShared(params.resourceID), payload)
      if (prepared.resource.state === "closed") return { resource: prepared.resource }
      const observation = yield* nativeHost.shared.close(prepared.resource, payload)
      const resource = yield* SharedBrowserControl.observeClose(db, prepared.resource, payload.requestID, observation)
      yield* nativeHost.shared.syncProjection(resource)
      return { resource }
    })))
    .handle("sharedFilesPreview", ({ params }) => mapped(Effect.gen(function* () {
      const payload = yield* strictBody(SharedBrowserFileSchema.PreviewRequest)
      const resource = yield* readShared(params.resourceID)
      if (!resource.policy.filePolicy?.[payload.direction]) return yield* BrowserControl.failure("BROWSER_SCOPE_DENIED")
      const active = yield* sharedFileReady(resource)
      const result = yield* files.shared.preview({ resourceID: resource.resourceID, scope: resource.scope, request: payload })
      const fresh = yield* SharedBrowserControl.requireActive(db, resource.resourceID, resource.scope)
      if (SharedBrowserControl.hash(fresh.resource) !== SharedBrowserControl.hash(active.resource) ||
        SharedBrowserControl.hash(fresh.lease) !== SharedBrowserControl.hash(active.lease) ||
        result.preview.bindingHash !== SharedBrowserFileBinding.hash(SharedBrowserFileBinding.from(fresh.resource, fresh.lease)))
        return yield* BrowserControl.failure("BROWSER_STALE_TARGET")
      yield* active.driver.current(fresh.resource, fresh.lease)
      const preview = result.preview
      const common = { direction: preview.direction, name: preview.name, relative: preview.relative, targetURL: preview.targetURL, observedAt: preview.observedAt }
      return { resourceID: resource.resourceID, previewID: result.previewID, resourceRevision: fresh.resource.revision,
        leaseID: fresh.lease.leaseID, leaseEpoch: fresh.lease.leaseEpoch, manualEpoch: fresh.resource.manualEpoch,
        preview: preview.direction === "upload" ? { ...common, direction: preview.direction, bytes: preview.bytes, sha256: preview.sha256 } :
          { ...common, direction: preview.direction, maxBytes: preview.maxBytes } }
    })))
    .handle("sharedFilesApprove", ({ params }) => mapped(Effect.gen(function* () {
      const payload = yield* strictBody(SharedBrowserFileSchema.Approve)
      const resource = yield* readShared(params.resourceID)
      const prior = yield* SharedBrowserFileExchange.requestGrant(db, { resourceID: resource.resourceID, scope: resource.scope, requestID: payload.requestID })
      // A historical exact request only reads its original immutable result. It cannot
      // confirm again, move the old grant to this lease, or revive a cold factory handle.
      if (prior) return { resourceID: resource.resourceID, ...yield* files.shared.approve({ resourceID: resource.resourceID, scope: resource.scope, command: payload }) }
      const decision = yield* files.shared.status({ resourceID: resource.resourceID, scope: resource.scope, requestID: payload.requestID })
      if (decision.state === "cancelled") return { resourceID: resource.resourceID,
        ...yield* files.shared.approve({ resourceID: resource.resourceID, scope: resource.scope, command: payload }) }
      if (!resource.policy.filePolicy) return yield* BrowserControl.failure("BROWSER_SCOPE_DENIED")
      const active = yield* sharedFileReady(resource)
      if (payload.expectedResourceRevision !== active.resource.revision || payload.expectedLeaseID !== active.lease.leaseID ||
        payload.expectedLeaseEpoch !== active.lease.leaseEpoch || payload.expectedManualEpoch !== active.resource.manualEpoch ||
        payload.expiresAt <= Date.now() || payload.expiresAt > Math.min(active.resource.expiresAt, active.lease.expiresAt))
        return yield* BrowserControl.failure("BROWSER_STALE_TARGET")
      return { resourceID: resource.resourceID, ...yield* files.shared.approve({ resourceID: resource.resourceID, scope: resource.scope, command: payload }) }
    })))
    .handle("sharedFilesStatus", ({ params }) => mapped(Effect.gen(function* () {
      const resource = yield* readShared(params.resourceID)
      return yield* files.shared.status({ resourceID: resource.resourceID, scope: resource.scope, requestID: params.requestID })
    })))
    .handle("sharedFilesList", ({ params, query }) => mapped(Effect.gen(function* () {
      const resource = yield* readShared(params.resourceID)
      return yield* files.shared.list({ resourceID: resource.resourceID, scope: resource.scope, ...query })
    })))
    .handle("filesPreview", ({ params, payload }) => mapped(Effect.gen(function* () {
      yield* native()
      const control = yield* read(params.controlID)
      const result = yield* files.preview({ controlID: control.controlID, scope: control.scope, request: payload })
      const preview = result.preview
      const common = { name: preview.name, relative: preview.relative, observedAt: preview.observedAt }
      return { controlID: control.controlID, previewID: result.previewID, controlRevision: control.revision,
        preview: preview.direction === "upload"
          ? { ...common, direction: preview.direction, bytes: preview.bytes, sha256: preview.sha256, targetPath: preview.targetPath }
          : { ...common, direction: preview.direction, maxBytes: preview.maxBytes, targetURL: preview.targetURL } }
    })))
    .handle("filesApprove", ({ params, payload }) => mapped(Effect.gen(function* () {
      yield* native()
      const control = yield* read(params.controlID)
      const result = yield* files.approve({ controlID: control.controlID, scope: control.scope, command: payload })
      return { controlID: control.controlID, ...result }
    })))
    .handle("filesStatus", ({ params }) => mapped(Effect.gen(function* () {
      const control = yield* read(params.controlID)
      return yield* files.status({ controlID: control.controlID, scope: control.scope, requestID: params.requestID })
    })))
    .handle("filesList", ({ params, query }) => mapped(Effect.gen(function* () {
      const control = yield* read(params.controlID)
      return yield* files.list({ controlID: control.controlID, scope: control.scope, ...query })
    })))
    .handle("get", ({ params }) => mapped(read(params.controlID).pipe(Effect.map(view))))
    .handle("action", ({ params }) => mapped(Effect.gen(function* () {
      yield* authenticate
      const action = yield* BrowserControl.getAction(db, params.actionID)
      if (!action) return yield* BrowserControl.failure("BROWSER_NOT_FOUND")
      const control = yield* read(action.controlID)
      return yield* BrowserControl.actionView(db, action, control, view(control))
    })))
    .handle("create", ({ payload }) => mapped(Effect.gen(function* () {
      const nativeHost = yield* native()
      const session = yield* db.select().from(SessionTable).where(eq(SessionTable.id, SessionSchema.ID.make(payload.sessionID)))
        .get().pipe(Effect.mapError(() => BrowserControl.failure("BROWSER_UNAVAILABLE")))
      if (!session) return yield* BrowserControl.failure("BROWSER_NOT_FOUND")
      if (session.workspace_id !== null || !session.v2_authority) return yield* scopeDenied("session_placement")
      const observed = yield* projects.observeDirectory(session.directory).pipe(Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : scopeDenied("project_observation")))
      const actual = yield* projectResolver.resolve(AbsolutePath.make(observed.directory)).pipe(Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : scopeDenied("project_resolution")))
      if (!observed.project || observed.directory !== session.directory || observed.project.id !== session.project_id ||
        actual.id !== observed.project.id || actual.vcs?.type !== observed.project.vcs)
        return yield* scopeDenied("project_current")
      const scope = yield* resolveBrowserLocation({ identity, directory: AbsolutePath.make(observed.directory),
        projectID: actual.id, git: actual.vcs?.type === "git" })
      const namespace = yield* db.select().from(SecurityNamespaceTable).where(eq(SecurityNamespaceTable.id, scope.securityNamespaceId))
        .get().pipe(Effect.mapError(() => BrowserControl.failure("BROWSER_UNAVAILABLE")))
      if (!namespace) return yield* scopeDenied("namespace_current")
      const created = yield* BrowserControl.create(db, { request: payload, hostID: nativeHost.hostID,
        hostIncarnation: nativeHost.hostIncarnation, credentialBinding: nativeHost.credentialBinding,
        ...(nativeHost.shared ? { sharedMainIncarnation: nativeHost.shared.mainIncarnation } : {}),
        scope: { principal: config.username, securityNamespaceID: scope.securityNamespaceId,
          locationKey: scope.locationKey, projectScopeKey: scope.projectScopeKey, namespaceBindingHash: namespace.binding_hash,
          sessionID: session.id, projectID: session.project_id, directory: scope.canonicalRoot, workspaceID: null } }).pipe(
            Effect.catch((error) => error.code === "BROWSER_SCOPE_DENIED" ? scopeDenied("control_scope") : Effect.fail(error)))
      if (!created.created) return view(created.record)
      yield* nativeHost.create(created.record).pipe(Effect.catch((error) =>
        BrowserControl.observeControl(db, created.record, "unknown").pipe(Effect.andThen(Effect.fail(error)))))
      return view(yield* BrowserControl.observeControl(db, created.record, "active"))
    })))
    .handle("cancel", ({ params, payload }) => mapped(Effect.gen(function* () {
      const nativeHost = yield* native(true)
      const control = yield* read(params.controlID)
      if (!nativeHost.verify(control, true).matched) return yield* BrowserControl.failure("BROWSER_HOST_UNAVAILABLE")
      const cancelled = yield* BrowserControl.cancel(db, control.controlID, control.scope, payload)
      if (cancelled.record.state === "stopped") return view(cancelled.record)
      const stopped = yield* nativeHost.cancel(cancelled.record)
      return view(stopped ? yield* BrowserControl.observeControl(db, cancelled.record, "stopped") : cancelled.record)
    })))
}))

function mapped<A, R>(body: Effect.Effect<A, BrowserSchema.Error | BrowserFileSchema.Error, R>) {
  return body.pipe(Effect.mapError((error) => {
    const payload = { code: error.code, message: error.message }
    if (["BROWSER_SCOPE_DENIED", "BROWSER_AUTHORITY_REQUIRED", "BROWSER_FILE_SCOPE_DENIED"].includes(error.code)) return new BrowserForbidden(payload)
    if (error.code === "BROWSER_NOT_FOUND") return new BrowserMissing(payload)
    if (["BROWSER_CONFLICT", "BROWSER_STALE_TARGET", "BROWSER_CANCELLED", "BROWSER_EXPIRED", "BROWSER_FILE_CHANGED",
      "BROWSER_FILE_CONFLICT", "BROWSER_FILE_INVALID"].includes(error.code)) return new BrowserConflict(payload)
    return new BrowserUnavailable(payload)
  }))
}
