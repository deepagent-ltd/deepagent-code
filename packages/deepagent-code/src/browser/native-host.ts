export * as BrowserNativeHost from "./native-host"

import { createHash, createHmac } from "node:crypto"
import { BrowserHost } from "@deepagent-code/core/browser/host"
import { BrowserControl } from "@deepagent-code/core/browser/control"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { BrowserProtocol } from "@deepagent-code/core/browser/protocol"
import { SharedBrowserProtocol } from "@deepagent-code/core/browser/shared-protocol"
import type { SharedBrowserHost } from "@deepagent-code/core/browser/shared-host"
import type { SharedBrowserSchema } from "@deepagent-code/core/browser/shared-schema"
import { SharedBrowserTuiSchema } from "@deepagent-code/core/browser/shared-tui-schema"
import { SharedBrowserFileBinding } from "@deepagent-code/core/browser/shared-file-binding"
import { SharedBrowserFileSchema } from "@deepagent-code/core/browser/shared-file-schema"
import { BrowserFileCapability } from "@deepagent-code/core/browser/file-capability"
import { BrowserFileExchange } from "@deepagent-code/core/browser/file-exchange"
import { BrowserFileSchema } from "@deepagent-code/core/browser/file-exchange.schema"
import { BrowserFileLeafBridge } from "./file-leaf-bridge"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Cause, Effect, Exit, Option, Queue, Schema, Stream } from "effect"

interface Port {
  postMessage(value: unknown): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
  on(event: "close", listener: () => void): void
  start(): void
  close(): void
}
interface ParentPort {
  postMessage(value: unknown): void
  on(event: "message", listener: (event: { data: unknown; ports: Port[] }) => void): void
}
let installed: BrowserHost.Interface | undefined
let prepared: Promise<void> | undefined
let observeConfiguration: ((username: string, password: string) => void) | undefined
export const current = () => installed
/** Actual listener construction supplies its captured ServerAuth configuration. A new
 * credential generation can only revoke this host incarnation, never reactivate it. */
export function captureServerConfiguration(config: { username: string; password: Option.Option<string> }) {
  observeConfiguration?.(config.username, Option.isSome(config.password) ? config.password.value : "")
}

/** Only the actual Electron utility process parent port can install this capability.
 * There is no exported arbitrary-port or callback registration factory. */
export function prepare() {
  if (prepared) return prepared
  const parent = Reflect.get(process, "parentPort") as ParentPort | undefined
  if (!parent || !process.versions.electron || Reflect.get(process, "type") !== "utility") return Promise.resolve()
  prepared = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Managed browser parent handshake timed out")), 30_000)
    parent.on("message", (event) => {
      const decoded = Schema.decodeUnknownOption(BrowserProtocol.Bootstrap, { onExcessProperty: "error" })(event.data)
      if (Option.isNone(decoded) || event.ports.length !== 1 || installed) return
      clearTimeout(timeout)
      installed = connect(event.ports[0]!, decoded.value)
      parent.postMessage({ type: "managed-browser-ready-v1" })
      resolve()
    })
    parent.postMessage({ type: "managed-browser-bootstrap-ready-v1" })
  })
  return prepared
}

function connect(port: Port, bootstrap: typeof BrowserProtocol.Bootstrap.Type): BrowserHost.Interface {
  let active = true
  let credentialActive = true
  const credentialsMatch = (username: string, password: string) => username === bootstrap.username && password.length > 0 &&
    createHmac("sha256", Buffer.from(bootstrap.credentialKey, "hex")).update("dac.browser.credentials.v1\0")
      .update(CanonicalJson.stringify({ username, password })).digest("hex") === bootstrap.credentialBinding
  const credentialRevocations = new Set<() => void>()
  observeConfiguration = (username, password) => { if (!credentialsMatch(username, password)) {
    credentialActive = false
    for (const revoke of credentialRevocations) revoke()
  } }
  const controls = new Map<string, { descriptor: string; resourceID: string; created: boolean; stopped: boolean; cancel?: Effect.Effect<boolean, BrowserSchema.Error> }>()
  const pending = new Map<string, { resolve: (result: BrowserProtocol.Response) => void; action?: BrowserSchema.Action;
    current?: () => Promise<boolean>; confirm?: { previewHash: string; commandHash: string; controlID: string };
    fileLeaf?: (request: BrowserProtocol.FileLeaf) => Promise<BrowserProtocol.FileLeafResponse> }>()
  const descriptor = (control: BrowserSchema.Control) => CanonicalJson.stringify({
    scope: control.scope, controlID: control.controlID, hostID: control.hostID, hostIncarnation: control.hostIncarnation,
    resourceID: control.resourceID, credentialBinding: control.credentialBinding, profile: control.profile,
    origin: control.origin, expiresAt: control.expiresAt, policyRevision: control.policyRevision,
    ...(control.profile === BrowserSchema.INTERACTION_PROFILE ? { postPaths: control.postPaths,
    ...(control.scriptGrants === undefined ? {} : { scriptGrants: control.scriptGrants }),
    ...(control.programGrants === undefined ? {} : { programGrants: control.programGrants }),
    ...(control.clipboardPolicy === undefined ? {} : { clipboardPolicy: control.clipboardPolicy }) } : {}),
    ...(control.profile === BrowserSchema.FILE_EXCHANGE_PROFILE ? { postPaths: control.postPaths, filePolicy: control.filePolicy } : {}),
    ...(control.profile === BrowserSchema.PUBLIC_READONLY_PROFILE ? { approvedOrigins: control.approvedOrigins, resolverPolicy: control.resolverPolicy } : {}),
    ...(control.profile === BrowserSchema.PUBLIC_INTERACTION_PROFILE ? { approvedOrigins: control.approvedOrigins,
      resolverPolicy: control.resolverPolicy, pageMode: control.pageMode, postTargets: control.postTargets } : {}),
    ...(control.profile === BrowserSchema.API_POST_PROFILE ? { approvedOrigins: control.approvedOrigins,
      resolverPolicy: control.resolverPolicy, pageMode: control.pageMode, apiPostTargets: control.apiPostTargets } : {}),
  })
  const verify = (control: BrowserSchema.Control, destroyOnly = false) => {
    const entry = controls.get(control.controlID)
    return { matched: active && entry?.descriptor === descriptor(control) && control.hostID === bootstrap.hostID &&
      control.hostIncarnation === bootstrap.hostIncarnation && control.credentialBinding === bootstrap.credentialBinding &&
      control.scope.principal === bootstrap.username && control.epoch === (control.cancel ? 2 : 1) &&
      (destroyOnly || entry.created || entry.stopped),
      stopped: active && entry?.descriptor === descriptor(control) && entry.stopped === true }
  }
  port.on("message", (event) => {
    const fileCheck = Schema.decodeUnknownOption(BrowserProtocol.FileCheck, { onExcessProperty: "error" })(event.data)
    if (Option.isSome(fileCheck)) {
      const entry = pending.get(fileCheck.value.confirmID)
      const allowed = active && credentialActive && entry?.confirm?.controlID === fileCheck.value.controlID &&
        entry.confirm.previewHash === fileCheck.value.previewHash && entry.confirm.commandHash === fileCheck.value.commandHash && entry.current
      void (allowed ? allowed() : Promise.resolve(false)).then((value) => {
        if (active) port.postMessage({ type: "permit", id: fileCheck.value.id, allowed: value && credentialActive })
      }, () => { if (active) port.postMessage({ type: "permit", id: fileCheck.value.id, allowed: false }) })
      return
    }
    const leaf = Schema.decodeUnknownOption(BrowserProtocol.FileLeaf, { onExcessProperty: "error" })(event.data)
    if (Option.isSome(leaf)) {
      const entry = pending.get(leaf.value.executeID)
      const allowed = active && credentialActive && entry?.action?.actionID === leaf.value.actionID &&
        entry.action.controlID === leaf.value.controlID && BrowserControl.hash(entry.action) === leaf.value.digest && entry.fileLeaf
      void (allowed ? allowed(leaf.value) : Promise.resolve({ type: "file.leaf.response" as const, id: leaf.value.id,
        error: "BROWSER_FILE_SCOPE_DENIED" as const })).then((response) => {
        if (active) port.postMessage(response)
      }, () => { if (active) port.postMessage({ type: "file.leaf.response", id: leaf.value.id, error: "BROWSER_FILE_UNKNOWN" }) })
      return
    }
    const closed = Schema.decodeUnknownOption(BrowserProtocol.Closed, { onExcessProperty: "error" })(event.data)
    if (Option.isSome(closed)) {
      const record = controls.get(closed.value.controlID)
      if (record && record.resourceID === closed.value.resourceID && closed.value.hostIncarnation === bootstrap.hostIncarnation) record.stopped = true
      return
    }
    const check = Schema.decodeUnknownOption(BrowserProtocol.Check, { onExcessProperty: "error" })(event.data)
    if (Option.isSome(check)) {
      const entry = [...pending.values()].find((entry) => entry.action?.actionID === check.value.actionID)
      const allowed = active && credentialActive && entry?.action?.controlID === check.value.controlID &&
        BrowserControl.hash(entry.action) === check.value.digest && entry.current
      void (allowed ? allowed() : Promise.resolve(false)).then((value) => {
        if (active) port.postMessage({ type: "permit", id: check.value.id, allowed: value && credentialActive })
      }, () => { if (active) port.postMessage({ type: "permit", id: check.value.id, allowed: false }) })
      return
    }
    const decoded = Schema.decodeUnknownOption(BrowserProtocol.Response, { onExcessProperty: "error" })(event.data)
    if (Option.isNone(decoded)) return
    pending.get(decoded.value.id)?.resolve(decoded.value)
  })
  port.on("close", () => {
    active = false
    for (const [id, entry] of pending) entry.resolve({ type: "response", id, error: "BROWSER_UNKNOWN" })
    pending.clear()
    controls.clear()
  })
  port.start()
  const rpc = (request: BrowserProtocol.Request, current?: () => Promise<boolean>,
    fileLeaf?: (request: BrowserProtocol.FileLeaf) => Promise<BrowserProtocol.FileLeafResponse>) => Effect.callback<BrowserProtocol.Response, BrowserSchema.Error>((resume) => {
    if (!active) { resume(Effect.fail(BrowserControl.failure("BROWSER_HOST_UNAVAILABLE"))); return }
    if (pending.size >= BrowserSchema.MAX_WAITING + BrowserSchema.MAX_ACTIVE_CONTROLS + 4 && request.type !== "cancel") {
      resume(Effect.fail(BrowserControl.failure("BROWSER_CAPACITY"))); return
    }
    const timer = setTimeout(() => {
      pending.delete(request.id)
      resume(Effect.fail(BrowserControl.failure("BROWSER_UNKNOWN")))
    }, request.type === "execute" ? Math.max(1, request.action.deadline - Date.now()) + 2_000 : request.type === "file.confirm"
      ? Math.max(1, Math.min(request.control.expiresAt, request.command.expiresAt) - Date.now()) : 10_000)
    pending.set(request.id, { ...(request.type === "execute" ? { action: request.action, current, fileLeaf } : {}),
      ...(request.type === "file.confirm" ? { current, confirm: { controlID: request.control.controlID,
        previewHash: BrowserControl.hash(request.preview), commandHash: BrowserControl.hash(request.command) } } : {}), resolve: (response) => {
      clearTimeout(timer)
      pending.delete(request.id)
      if (response.stopped) {
        const record = controls.get(request.control.controlID)
        if (record) record.stopped = true
      }
      resume(response.error ? Effect.fail(BrowserControl.failure(response.error)) : Effect.succeed(response))
    } })
    port.postMessage(request)
    return Effect.sync(() => { clearTimeout(timer); pending.delete(request.id) })
  })
  const cancel = (control: BrowserSchema.Control) => Effect.gen(function* () {
    if (!verify(control, true).matched) return yield* BrowserControl.failure("BROWSER_AUTHORITY_REQUIRED")
    const entry = controls.get(control.controlID)!
    if (entry.stopped) return true
    // Allocate the lazy cache before publishing it. Competing callers only execute the one
    // published effect; repeated cancel observations cannot flood the private channel.
    const operation = yield* Effect.cached(rpc({ type: "cancel", id: crypto.randomUUID(), control }).pipe(
      Effect.map((response) => response.stopped === true), Effect.uninterruptible))
    entry.cancel ??= operation
    return yield* entry.cancel
  })
  return {
    hostID: bootstrap.hostID, hostIncarnation: bootstrap.hostIncarnation,
    ...(bootstrap.sharedMainIncarnation ? { shared: connectShared(port, bootstrap.sharedMainIncarnation,
      bootstrap.hostIncarnation, bootstrap.username, bootstrap.credentialBinding, () => active, () => credentialActive,
      (revoke) => credentialRevocations.add(revoke)) } : {}),
    principal: bootstrap.username, credentialBinding: bootstrap.credentialBinding,
    matchesCredentials: (username, password) => active && credentialActive && credentialsMatch(username, password),
    alive: () => active, verify,
    create: (control) => Effect.gen(function* () {
      if (!active || !credentialActive || controls.size >= BrowserSchema.MAX_CONTROLS || controls.has(control.controlID) ||
        control.hostID !== bootstrap.hostID || control.hostIncarnation !== bootstrap.hostIncarnation ||
        control.scope.principal !== bootstrap.username || control.credentialBinding !== bootstrap.credentialBinding ||
        control.epoch !== 1 || control.state !== "creating") return yield* BrowserControl.failure("BROWSER_AUTHORITY_REQUIRED")
      const entry = { descriptor: descriptor(control), resourceID: control.resourceID, created: false, stopped: false }
      controls.set(control.controlID, entry)
      yield* rpc({ type: "create", id: crypto.randomUUID(), control })
      entry.created = true
    }),
    cancel,
    confirmFiles: (control, preview, command, current) => Effect.gen(function* () {
      if (!credentialActive || !verify(control).matched || verify(control).stopped ||
        control.profile !== BrowserSchema.FILE_EXCHANGE_PROFILE) return yield* BrowserFileExchange.failure()
      const context = yield* Effect.context<never>()
      const check = () => Effect.runPromiseWith(context)(Effect.exit(current)).then((exit) => credentialActive && Exit.isSuccess(exit))
      yield* current
      const response = yield* rpc({ type: "file.confirm", id: crypto.randomUUID(), control, preview, command }, check)
        .pipe(Effect.mapError(() => BrowserFileExchange.failure("BROWSER_FILE_CHANGED")))
      if (!credentialActive || !response.confirmation) return yield* BrowserFileExchange.failure("BROWSER_FILE_CHANGED")
      yield* current
      return response.confirmation
    }),
    execute: (control, action, current) => Effect.scoped(Effect.gen(function* () {
      if (!credentialActive || !verify(control).matched || verify(control).stopped) return yield* BrowserControl.failure("BROWSER_AUTHORITY_REQUIRED")
      const context = yield* Effect.context<never>()
      const check = () => !credentialActive ? Promise.resolve(false) : Effect.runPromiseWith(context)(Effect.exit(current)).then((exit) => credentialActive && Exit.isSuccess(exit))
      yield* current
      const fileOperation = action.command.type === "file.upload" || action.command.type === "file.download"
      const capability = yield* Effect.serviceOption(BrowserFileCapability.Service)
      const listing = action.command.type === "files.list" && Option.isSome(capability) && capability.value.listFiles ?
        yield* capability.value.listFiles({ controlID: control.controlID, scope: control.scope,
          ...(action.command.cursor === undefined ? {} : { cursor: action.command.cursor }),
          ...(action.command.limit === undefined ? {} : { limit: action.command.limit }) })
          .pipe(Effect.mapError(() => BrowserControl.failure("BROWSER_SCOPE_DENIED"))) : undefined
      if (action.command.type === "files.list" && !listing) return yield* BrowserControl.failure("BROWSER_HOST_UNAVAILABLE")
      if (fileOperation && (Option.isNone(capability) || !capability.value.executionFiles || !capability.value.recordObservation || !capability.value.unknownAction))
        return yield* BrowserControl.failure("BROWSER_HOST_UNAVAILABLE")
      const prepared = fileOperation && Option.isSome(capability) && capability.value.executionFiles ?
        yield* capability.value.executionFiles({ control, action,
          current: current.pipe(Effect.mapError(() => BrowserFileExchange.failure("BROWSER_FILE_CHANGED"))) })
          .pipe(Effect.mapError(() => BrowserControl.failure("BROWSER_SCOPE_DENIED"))) : undefined
      const files = prepared?.files
      const transfer = prepared?.transfer
      const bridge = transfer && files && Option.isSome(capability) ? BrowserFileLeafBridge.make({
        capability: capability.value, transfer, files, current: check, context }) : undefined
      const leaf = bridge ? async (request: BrowserProtocol.FileLeaf): Promise<BrowserProtocol.FileLeafResponse> =>
        ({ type: "file.leaf.response", id: request.id, ...await bridge.leaf(request) }) : undefined
      const response = yield* rpc({ type: "execute", id: crypto.randomUUID(), control, action, ...(files ? { files } : {}) }, check, leaf).pipe(
        Effect.onInterrupt(() => cancel(control).pipe(Effect.catch(() => Effect.void), Effect.uninterruptible)),
        Effect.tapError(() => transfer && Option.isSome(capability) && capability.value.unknownAction ? capability.value.unknownAction(transfer)
          .pipe(Effect.catch(() => Effect.void)) : Effect.void),
      )
      if (!response.result) return yield* BrowserControl.failure("BROWSER_UNKNOWN")
      if (bridge) yield* bridge.complete(response.result)
      if (response.png !== undefined) {
        const bytes = Buffer.from(response.png, "base64")
        if (bytes.length > BrowserSchema.MAX_PNG_BYTES || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
          !response.result.image || bytes.length !== response.result.image.bytes ||
          createHash("sha256").update(bytes).digest("hex") !== response.result.image.hash)
          return yield* BrowserControl.failure("BROWSER_UNKNOWN")
      }
      return { result: listing ? { ...response.result, files: listing.files, fileGrants: listing.grants,
        ...(listing.nextCursor === null ? {} : { nextFileCursor: listing.nextCursor }) } : response.result,
        ...(response.png === undefined ? {} : { png: response.png }) }
    })),
  }
}

/** The only caller is the successful utility-process bootstrap above. Keeping this
 * private prevents a public HTTP descriptor from installing another native authority. */
function connectShared(port: Port, mainIncarnation: string, sidecarIncarnation: string,
  principal: string, credentialBinding: string, alive: () => boolean, authorized: () => boolean,
  onRevoke: (callback: () => void) => void): SharedBrowserHost.Interface {
  const pending = new Map<string, { request: SharedBrowserProtocol.Request;
    current?: () => Promise<boolean>; fileLeaf?: (request: SharedBrowserProtocol.FileLeaf) => Promise<SharedBrowserProtocol.FileLeafResponse>;
    resolve: (response: SharedBrowserProtocol.Response) => void }>()
  const belongs = (resource: SharedBrowserSchema.Resource) => resource.mainIncarnation === mainIncarnation &&
    resource.scope.principal === principal && resource.rootSessionID === resource.scope.sessionID
  port.on("message", (event) => {
    const leaf = Schema.decodeUnknownOption(SharedBrowserProtocol.FileLeaf, { onExcessProperty: "error" })(event.data)
    if (Option.isSome(leaf)) {
      const entry = pending.get(leaf.value.executeID)
      const request = entry?.request
      const allowed = alive() && authorized() && request?.type === "shared.execute" &&
        request.action.actionID === leaf.value.actionID && request.action.commandHash === leaf.value.commandHash &&
        SharedBrowserFileBinding.hash(SharedBrowserFileBinding.from(request.resource, request.lease)) === SharedBrowserFileBinding.hash(leaf.value.binding) &&
        SharedBrowserFileBinding.hash(SharedBrowserProtocol.fileExecution(request.resource, request.lease, request.action)) === leaf.value.executionHash && entry?.fileLeaf
      void (allowed ? allowed(leaf.value) : Promise.resolve({ type: "shared.file.leaf.response" as const, id: leaf.value.id,
        error: "BROWSER_FILE_SCOPE_DENIED" as const })).then((response) => {
        if (alive() && (response.error || (authorized() && entry !== undefined && pending.get(entry.request.id) === entry))) port.postMessage(response)
      }, () => { if (alive()) port.postMessage({ type: "shared.file.leaf.response", id: leaf.value.id, error: "BROWSER_FILE_UNKNOWN" }) })
      return
    }
    const fileCheck = Schema.decodeUnknownOption(SharedBrowserProtocol.FileCheck, { onExcessProperty: "error" })(event.data)
    if (Option.isSome(fileCheck)) {
      const entry = pending.get(fileCheck.value.confirmID)
      const request = entry?.request
      const exact = alive() && authorized() && request?.type === "shared.file.confirm" &&
        fileCheck.value.mainIncarnation === mainIncarnation && fileCheck.value.sidecarIncarnation === sidecarIncarnation &&
        request.resource.resourceID === fileCheck.value.resourceID && request.lease.leaseID === fileCheck.value.leaseID &&
        request.lease.leaseEpoch === fileCheck.value.leaseEpoch && request.resource.manualEpoch === fileCheck.value.manualEpoch &&
        request.preview.bindingHash === fileCheck.value.bindingHash &&
        SharedBrowserFileBinding.hash(SharedBrowserFileBinding.from(request.resource, request.lease)) === fileCheck.value.bindingHash &&
        SharedBrowserFileBinding.hash(request.preview) === fileCheck.value.previewHash &&
        SharedBrowserFileBinding.hash(request.command) === fileCheck.value.commandHash && entry?.current
      void (exact ? exact() : Promise.resolve(false)).then((valid) => {
        if (!alive()) return
        port.postMessage({ type: "permit", id: fileCheck.value.id, allowed: valid && authorized() &&
          entry !== undefined && pending.get(entry.request.id) === entry })
      }, () => { if (alive()) port.postMessage({ type: "permit", id: fileCheck.value.id, allowed: false }) })
      return
    }
    const check = Schema.decodeUnknownOption(SharedBrowserProtocol.Check, { onExcessProperty: "error" })(event.data)
    if (Option.isSome(check)) {
      const entry = [...pending.values()].find((value) => value.request.type === "shared.execute" &&
        value.request.action.actionID === check.value.actionID)
      const request = entry?.request
      const allowed = alive() && authorized() && request?.type === "shared.execute" &&
        request.resource.resourceID === check.value.resourceID && request.lease.leaseID === check.value.leaseID &&
        request.action.leaseEpoch === check.value.leaseEpoch && request.action.manualEpoch === check.value.manualEpoch &&
        request.action.commandHash === check.value.commandHash && entry?.current
      void (allowed ? allowed() : Promise.resolve(false)).then((valid) => {
        if (!alive()) return
        port.postMessage({ type: "permit", id: check.value.id, allowed: valid && alive() && authorized() &&
          entry !== undefined && pending.get(entry.request.id) === entry })
      }, () => { if (alive()) port.postMessage({ type: "permit", id: check.value.id, allowed: false }) })
      return
    }
    const response = Schema.decodeUnknownOption(SharedBrowserProtocol.Response, { onExcessProperty: "error" })(event.data)
    if (Option.isSome(response)) pending.get(response.value.id)?.resolve(response.value)
  })
  port.on("close", () => {
    for (const [id, entry] of pending) entry.resolve({ type: "shared.response", id, error: "BROWSER_UNKNOWN" })
    pending.clear()
  })
  const rpc = (request: SharedBrowserProtocol.Request, current?: () => Promise<boolean>,
    fileLeaf?: (request: SharedBrowserProtocol.FileLeaf) => Promise<SharedBrowserProtocol.FileLeafResponse>) =>
    Effect.callback<SharedBrowserProtocol.Response, BrowserSchema.Error>((resume) => {
      if (!alive()) { resume(Effect.fail(BrowserControl.failure("BROWSER_HOST_UNAVAILABLE"))); return }
      const reducing = request.type === "shared.takeover" || request.type === "shared.barrier.commit" || request.type === "shared.close" ||
        request.type === "shared.status" || request.type === "shared.projection.sync" || request.type === "shared.policy.abort" ||
        request.type === "shared.tui.disconnect" || request.type === "shared.tui.detach"
      if (!reducing && !authorized()) {
        resume(Effect.fail(BrowserControl.failure("BROWSER_HOST_UNAVAILABLE")))
        return
      }
      if (pending.size >= BrowserSchema.MAX_WAITING + BrowserSchema.MAX_ACTIVE_CONTROLS && !reducing) {
        resume(Effect.fail(BrowserControl.failure("BROWSER_CAPACITY")))
        return
      }
      if ("resource" in request && !belongs(request.resource)) {
        resume(Effect.fail(BrowserControl.failure("BROWSER_SCOPE_DENIED")))
        return
      }
      if ("lease" in request && request.lease.sidecarIncarnation !== sidecarIncarnation) {
        resume(Effect.fail(BrowserControl.failure("BROWSER_AUTHORITY_REQUIRED")))
        return
      }
      const timer = setTimeout(() => {
        pending.delete(request.id)
        resume(Effect.fail(BrowserControl.failure("BROWSER_UNKNOWN")))
      }, request.type === "shared.execute" ? Math.max(1, request.action.deadline - Date.now()) + 2_000 :
        request.type === "shared.file.confirm" ? Math.max(1, Math.min(2_147_483_647,
          request.resource.expiresAt - Date.now(), request.lease.expiresAt - Date.now(), request.command.expiresAt - Date.now())) : 10_000)
      pending.set(request.id, { request, current, fileLeaf, resolve: (response) => {
        clearTimeout(timer)
        pending.delete(request.id)
        resume(response.error ? Effect.fail(BrowserControl.failure(response.error)) : Effect.succeed(response))
      } })
      port.postMessage(request)
      return Effect.sync(() => { clearTimeout(timer); pending.delete(request.id) })
    })
  const observe = (request: SharedBrowserProtocol.Request) => rpc(request).pipe(Effect.flatMap((response) =>
    response.observation ? Effect.succeed(response.observation) : Effect.fail(BrowserControl.failure("BROWSER_UNKNOWN"))))
  const fileError = (error: BrowserSchema.Error) => BrowserFileExchange.failure(
    error.code === "BROWSER_CAPACITY" ? "BROWSER_FILE_CAPACITY" : "BROWSER_FILE_CHANGED")
  const matchesCancellation = (resource: SharedBrowserSchema.Resource, preview: SharedBrowserFileSchema.Preview,
    command: SharedBrowserFileSchema.Approve, decision: SharedBrowserFileSchema.Cancellation) =>
    decision.resourceID === resource.resourceID && decision.requestID === command.requestID &&
    decision.bindingHash === preview.bindingHash && decision.previewHash === SharedBrowserFileBinding.hash(preview) &&
    decision.commandHash === SharedBrowserFileBinding.hash(command) && decision.cancelledAt >= preview.observedAt &&
    decision.cancelledAt <= command.expiresAt && decision.cancelledAt <= Date.now()
  const files: SharedBrowserHost.Files = {
    ready: (resource, lease) => Effect.gen(function* () {
      yield* files.current(resource, lease)
      const response = yield* rpc({ type: "shared.file.current", id: crypto.randomUUID(), resource, lease }).pipe(Effect.mapError(fileError))
      return alive() && authorized() && response.fileCurrent === true && response.fileReady === true
    }),
    current: (resource, lease) => Effect.gen(function* () {
      const binding = SharedBrowserFileBinding.from(resource, lease)
      if (!alive() || !authorized() || !belongs(resource) || lease.resourceID !== resource.resourceID ||
        lease.sidecarIncarnation !== sidecarIncarnation || lease.mainIncarnation !== mainIncarnation ||
        resource.liveLeaseID !== lease.leaseID || resource.manualEpoch !== lease.manualEpoch ||
        resource.state !== "agent_owned" || lease.state !== "active" || !resource.resourceAlive ||
        resource.agentAccessFenced || resource.manualEnabled || Math.min(resource.expiresAt, lease.expiresAt) <= Date.now() ||
        resource.policyHash !== binding.policyHash || lease.policyHash !== binding.policyHash ||
        SharedBrowserFileBinding.hash(lease.scope) !== binding.scopeHash)
        return yield* BrowserFileExchange.failure("BROWSER_FILE_CHANGED")
      const response = yield* rpc({ type: "shared.file.current", id: crypto.randomUUID(), resource, lease }).pipe(Effect.mapError(fileError))
      if (!alive() || !authorized() || response.fileCurrent !== true) return yield* BrowserFileExchange.failure("BROWSER_FILE_CHANGED")
    }),
    confirm: (resource, lease, preview, command, checks) => Effect.gen(function* () {
      const binding = SharedBrowserFileBinding.from(resource, lease)
      if (preview.bindingHash !== SharedBrowserFileBinding.hash(binding) ||
        SharedBrowserFileBinding.hash(preview.binding) !== preview.bindingHash || preview.scopeHash !== binding.scopeHash ||
        command.expectedResourceRevision !== resource.revision || command.expectedLeaseID !== lease.leaseID ||
        command.expectedLeaseEpoch !== lease.leaseEpoch || command.expectedManualEpoch !== resource.manualEpoch ||
        command.expiresAt <= Date.now() || command.expiresAt > Math.min(resource.expiresAt, lease.expiresAt))
        return yield* BrowserFileExchange.failure("BROWSER_FILE_CHANGED")
      yield* checks.previewCurrent
      yield* files.current(resource, lease)
      const context = yield* Effect.context<never>()
      const check = () => alive() && authorized() ? Effect.runPromiseWith(context)(Effect.exit(checks.authorityCurrent)).then((exit) =>
        alive() && authorized() && Exit.isSuccess(exit)) : Promise.resolve(false)
      const response = yield* rpc({ type: "shared.file.confirm", id: crypto.randomUUID(), resource, lease, preview, command }, check)
        .pipe(Effect.mapError(fileError))
      const decision = response.fileCancellation ?? response.confirmation
      if (!alive() || !authorized() || !decision || !!response.confirmation === !!response.fileCancellation)
        return yield* BrowserFileExchange.failure("BROWSER_FILE_CHANGED")
      if ("kind" in decision && !matchesCancellation(resource, preview, command, decision))
        return yield* BrowserFileExchange.failure("BROWSER_FILE_CHANGED")
      if (!("kind" in decision) && (decision.previewHash !== SharedBrowserFileBinding.hash(preview) ||
        decision.commandHash !== SharedBrowserFileBinding.hash(command) ||
        decision.confirmedAt < preview.observedAt || decision.confirmedAt > Date.now()))
        return yield* BrowserFileExchange.failure("BROWSER_FILE_CHANGED")
      // Both decisions retain the full file/installation observation outside Main's bounded permit.
      yield* checks.previewCurrent
      yield* files.current(resource, lease)
      return decision
    }),
    cancellation: (resource, lease, preview, command) => Effect.gen(function* () {
      const binding = SharedBrowserFileBinding.from(resource, lease)
      if (!alive() || !authorized() || !belongs(resource) ||
        preview.bindingHash !== SharedBrowserFileBinding.hash(binding) ||
        SharedBrowserFileBinding.hash(preview.binding) !== preview.bindingHash || preview.scopeHash !== binding.scopeHash ||
        command.expectedResourceRevision !== resource.revision || command.expectedLeaseID !== lease.leaseID ||
        command.expectedLeaseEpoch !== lease.leaseEpoch || command.expectedManualEpoch !== resource.manualEpoch)
        return yield* BrowserFileExchange.failure("BROWSER_FILE_CHANGED")
      // This reads only the original settled decision. A later lease expiry cannot
      // create a new decision, and must not erase a cancellation already observed by Main.
      const response = yield* rpc({ type: "shared.file.confirm.status", id: crypto.randomUUID(), resource, lease, preview, command })
        .pipe(Effect.mapError(fileError))
      if (!alive() || !authorized() || response.confirmation ||
        response.fileCancellation && !matchesCancellation(resource, preview, command, response.fileCancellation))
        return yield* BrowserFileExchange.failure("BROWSER_FILE_CHANGED")
      return response.fileCancellation
    }),
  }
  return {
    mainIncarnation,
    files,
    tui: connectTui(port, rpc, { hostIncarnation: sidecarIncarnation, credentialBinding }, alive, authorized, onRevoke),
    validateInput: (stamp) => rpc({ type: "shared.input.validate", id: crypto.randomUUID(), stamp }).pipe(
      Effect.map((response) => response.validInput === true)),
    policy: {
      claim: (resource, command) => rpc({ type: "shared.policy.claim", id: crypto.randomUUID(), resource, command }).pipe(
        Effect.flatMap((response) => response.policyClaim ? Effect.succeed(response.policyClaim) : Effect.fail(BrowserControl.failure("BROWSER_UNKNOWN")))),
      check: (resource, command, claim) => observe({ type: "shared.policy.check", id: crypto.randomUUID(), resource, command, claim }).pipe(Effect.asVoid),
      abort: (resource, command, claim) => observe({ type: "shared.policy.abort", id: crypto.randomUUID(), resource, command, claim }),
      commit: (resource, command) => observe({ type: "shared.policy.commit", id: crypto.randomUUID(), resource, command }),
    },
    create: (resource, lease) => observe({ type: "shared.create", id: crypto.randomUUID(), resource, lease }),
    status: (resourceID) => observe({ type: "shared.status", id: crypto.randomUUID(), resourceID }),
    syncProjection: (resource) => observe({ type: "shared.projection.sync", id: crypto.randomUUID(), resource }),
    takeover: (resource, request) => rpc({ type: "shared.takeover", id: crypto.randomUUID(), resource, request }).pipe(
      Effect.flatMap((response) => response.ticket ? Effect.succeed(response.ticket) : Effect.fail(BrowserControl.failure("BROWSER_UNKNOWN")))),
    confirmBarrier: (resource, ticket) => observe({ type: "shared.barrier.commit", id: crypto.randomUUID(), resource, ticket }),
    acquire: (resource, lease, witness) => observe({ type: "shared.acquire", id: crypto.randomUUID(), resource, lease, witness }),
    close: (resource, request) => observe({ type: "shared.close", id: crypto.randomUUID(), resource, request }),
    execute: (resource, lease, action, current) => Effect.scoped(Effect.gen(function* () {
      const context = yield* Effect.context<never>()
      const check = () => alive() && authorized() ? Effect.runPromiseWith(context)(Effect.exit(current)).then((exit) =>
        alive() && authorized() && Exit.isSuccess(exit)) : Promise.resolve(false)
      yield* current
      const fileOperation = action.command.type === "file.upload" || action.command.type === "file.download"
      if (fileOperation && (!files.ready || !(yield* files.ready(resource, lease).pipe(Effect.mapError(() => BrowserControl.failure("BROWSER_DRIVER_UNAVAILABLE"))))))
        return yield* BrowserControl.failure("BROWSER_DRIVER_UNAVAILABLE")
      const capability = yield* Effect.serviceOption(BrowserFileCapability.Service)
      if (fileOperation && (Option.isNone(capability) || !capability.value.shared || !capability.value.recordObservation || !capability.value.unknownAction))
        return yield* BrowserControl.failure("BROWSER_DRIVER_UNAVAILABLE")
      const prepared = fileOperation && Option.isSome(capability) && capability.value.shared ? yield* capability.value.shared.executionFiles({ resource, lease, action,
        current: current.pipe(Effect.mapError(() => BrowserFileExchange.failure("BROWSER_FILE_CHANGED"))) })
        .pipe(Effect.mapError(() => BrowserControl.failure("BROWSER_SCOPE_DENIED"))) : undefined
      const bridge = prepared && Option.isSome(capability) ? BrowserFileLeafBridge.make({ capability: capability.value,
        transfer: prepared.transfer, files: prepared.files, current: check, context }) : undefined
      const leaf = bridge ? async (request: SharedBrowserProtocol.FileLeaf): Promise<SharedBrowserProtocol.FileLeafResponse> =>
        ({ type: "shared.file.leaf.response", id: request.id, ...await bridge.leaf(request) }) : undefined
      const listing = action.command.type === "files.list" ? yield* Effect.gen(function* () {
        if (Option.isNone(capability) || !capability.value.shared?.listFiles) return yield* BrowserControl.failure("BROWSER_DRIVER_UNAVAILABLE")
        return yield* capability.value.shared.listFiles({ resourceID: resource.resourceID, scope: resource.scope,
          ...(action.command.type === "files.list" && action.command.cursor !== undefined ? { cursor: action.command.cursor } : {}),
          ...(action.command.type === "files.list" && action.command.limit !== undefined ? { limit: action.command.limit } : {}) })
          .pipe(Effect.mapError(() => BrowserControl.failure("BROWSER_SCOPE_DENIED")))
      }) : undefined
      const response = yield* rpc({ type: "shared.execute", id: crypto.randomUUID(), resource, lease, action,
        ...(prepared ? { files: prepared.files } : {}) }, check, leaf).pipe(
          Effect.onInterrupt(() => bridge ? bridge.unknown.pipe(Effect.uninterruptible) : Effect.void),
          Effect.tapError(() => bridge ? bridge.unknown : Effect.void))
      if (!response.result) return yield* BrowserControl.failure("BROWSER_UNKNOWN")
      if (bridge) yield* bridge.complete(response.result)
      yield* current
      return { result: listing ? { ...response.result, files: listing.files, fileGrants: listing.grants,
        ...(listing.nextCursor === null ? {} : { nextFileCursor: listing.nextCursor }) } : response.result,
        ...(response.png === undefined ? {} : { png: response.png }) }
    })),
  }
}

/** Only connectShared can install this transport. A public HTTP caller supplies a
 * challenge, never the private bootstrap identity or original stream incarnation. */
function connectTui(
  port: Port,
  rpc: (request: SharedBrowserProtocol.Request) => Effect.Effect<SharedBrowserProtocol.Response, BrowserSchema.Error>,
  identity: { hostIncarnation: string; credentialBinding: string },
  alive: () => boolean,
  authorized: () => boolean,
  onRevoke: (callback: () => void) => void,
): SharedBrowserHost.Tui {
  const streams = new Map<
    string,
    {
      binding: SharedBrowserTuiSchema.StreamBinding
      notify: (view: SharedBrowserTuiSchema.View) => void
      fail: () => void
    }
  >()
  const waiting = new Map<string, number>()
  const disconnect = (binding: SharedBrowserTuiSchema.StreamBinding) =>
    rpc({
      type: "shared.tui.disconnect",
      id: crypto.randomUUID(),
      binding,
    }).pipe(
      Effect.asVoid,
      Effect.catch(() => Effect.void),
    )
  const retire = () => {
    for (const entry of streams.values()) {
      entry.fail()
      void Effect.runPromise(disconnect(entry.binding))
    }
    streams.clear()
  }
  port.on("close", retire)
  onRevoke(retire)
  port.on("message", (event) => {
    const decoded = Schema.decodeUnknownOption(SharedBrowserTuiSchema.State, { onExcessProperty: "error" })(event.data)
    if (Option.isNone(decoded)) return
    const entry = streams.get(decoded.value.attachID)
    if (
      !alive() ||
      !authorized() ||
      !entry ||
      entry.binding.generation !== decoded.value.generation ||
      entry.binding.streamID !== decoded.value.streamID ||
      decoded.value.view.attachID !== decoded.value.attachID ||
      decoded.value.view.generation !== decoded.value.generation
    )
      return
    entry.notify(decoded.value.view)
  })
  const bounded = <A>(source: string, effect: Effect.Effect<A, BrowserSchema.Error>) =>
    Effect.suspend(() => {
      if (
        (waiting.get(source) ?? 0) >= SharedBrowserTuiSchema.MAX_PER_SOURCE ||
        [...waiting.values()].reduce((sum, count) => sum + count, 0) >= SharedBrowserTuiSchema.MAX_WAITING
      )
        return Effect.fail(BrowserControl.failure("BROWSER_CAPACITY"))
      waiting.set(source, (waiting.get(source) ?? 0) + 1)
      return effect.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            const count = (waiting.get(source) ?? 1) - 1
            if (count) waiting.set(source, count)
            if (!count) waiting.delete(source)
          }),
        ),
      )
    })
  const view = (response: SharedBrowserProtocol.Response) =>
    response.tuiView ? Effect.succeed(response.tuiView) : Effect.fail(BrowserControl.failure("BROWSER_UNKNOWN"))
  return {
    pair: (input, serverURL) =>
      bounded(
        `pair:${input.requestID}`,
        rpc({ type: "shared.tui.pair", id: crypto.randomUUID(), input, transport: { ...identity, serverURL } }).pipe(
          Effect.flatMap(view),
        ),
      ),
    owner: (input, serverURL) =>
      Stream.callback<SharedBrowserTuiSchema.View, BrowserSchema.Error>(
        (queue) =>
          Effect.gen(function* () {
            if (!alive() || !authorized()) return yield* BrowserControl.failure("BROWSER_HOST_UNAVAILABLE")
            if (streams.has(input.attachID)) return yield* BrowserControl.failure("BROWSER_CONFLICT")
            if (streams.size >= SharedBrowserTuiSchema.MAX_PENDING + SharedBrowserTuiSchema.MAX_ACTIVE)
              return yield* BrowserControl.failure("BROWSER_CAPACITY")
            const binding = { attachID: input.attachID, generation: input.generation, streamID: crypto.randomUUID() }
            const current: { view?: SharedBrowserTuiSchema.View } = {}
            const entry = {
              binding,
              notify: (value: SharedBrowserTuiSchema.View) => {
                if (
                  current.view &&
                  (value.barrierOrder < current.view.barrierOrder ||
                    ["pending", "active", "retired"].indexOf(value.state) <
                      ["pending", "active", "retired"].indexOf(current.view.state))
                )
                  return
                current.view = value
                Queue.offerUnsafe(queue, value)
              },
              fail: () => {
                Queue.failCauseUnsafe(queue, Cause.fail(BrowserControl.failure("BROWSER_HOST_UNAVAILABLE")))
              },
            }
            streams.set(input.attachID, entry)
            // Register before sending open: a lost ACK or cancellation must still retire Main's
            // original source, including when the response body never starts consuming.
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                if (streams.get(input.attachID) === entry) streams.delete(input.attachID)
                yield* disconnect(binding)
              }),
            )
            const opened = yield* bounded(
              input.attachID,
              rpc({
                type: "shared.tui.open",
                id: crypto.randomUUID(),
                input,
                binding,
                transport: { ...identity, serverURL },
              }).pipe(Effect.flatMap(view)),
            )
            entry.notify(opened)
          }),
        { bufferSize: 1, strategy: "sliding" },
      ).pipe(Stream.takeUntil((value) => value.state === "retired")),
    reserve: (input) =>
      Effect.suspend(() =>
        streams.get(input.attachID)?.binding.generation !== input.generation
          ? Effect.fail(BrowserControl.failure("BROWSER_AUTHORITY_REQUIRED"))
          : bounded(
              input.attachID,
              rpc({ type: "shared.tui.reserve", id: crypto.randomUUID(), input }).pipe(
                Effect.map((response) => response.inputStamp),
              ),
            ),
      ),
    // Main alone distinguishes a new seal from immutable readback after a lost ACK.
    // A retired source may recover only the already-sealed exact original bytes.
    seal: (input) => bounded(input.attachID,
      rpc({ type: "shared.tui.seal", id: crypto.randomUUID(), input }).pipe(
        Effect.flatMap((response) => response.inputStamp ? Effect.succeed(response.inputStamp) :
          Effect.fail(BrowserControl.failure("BROWSER_UNKNOWN"))))),
    detach: (input) => rpc({ type: "shared.tui.detach", id: crypto.randomUUID(), input }).pipe(Effect.flatMap(view)),
  }
}
