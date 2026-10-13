export * as BrowserNativeHost from "./native-host"

import { createHash, createHmac } from "node:crypto"
import { BrowserHost } from "@deepagent-code/core/browser/host"
import { BrowserControl } from "@deepagent-code/core/browser/control"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { BrowserProtocol } from "@deepagent-code/core/browser/protocol"
import { BrowserFileCapability } from "@deepagent-code/core/browser/file-capability"
import { BrowserFileExchange } from "@deepagent-code/core/browser/file-exchange"
import { BrowserFileSchema } from "@deepagent-code/core/browser/file-exchange.schema"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Effect, Exit, Option, Schema } from "effect"

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
  observeConfiguration = (username, password) => { if (!credentialsMatch(username, password)) credentialActive = false }
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
      const completed = new Map<string, BrowserFileCapability.Observation>()
      const owned = { busy: false, started: false }
      const leaf = transfer && files && Option.isSome(capability) ?
        async (request: BrowserProtocol.FileLeaf): Promise<BrowserProtocol.FileLeafResponse> => {
          const entry = files.find((entry) => entry.artifact.artifactID === request.artifactID)
          if (!entry || !transfer || owned.busy || completed.has(request.artifactID))
            return { type: "file.leaf.response", id: request.id, error: "BROWSER_FILE_CHANGED" }
          // Claim before the asynchronous current check; two leaves must never share a capture offset.
          owned.busy = true
          const file = capability.value
          try {
            if (!await check()) return { type: "file.leaf.response", id: request.id, error: "BROWSER_FILE_CHANGED" }
            owned.started = true
            const response = await Effect.runPromiseWith(context)(Effect.gen(function* () {
              yield* file.current(transfer)
              if (request.operation === "upload.read") {
                const bytes = yield* file.readUpload(transfer, { artifactID: request.artifactID, offset: request.offset, bytes: request.length })
                return { type: "file.leaf.response" as const, id: request.id, payload: Buffer.from(bytes).toString("base64") }
              }
              if (request.operation === "download.write") {
                const bytes = Buffer.from(request.payload, "base64")
                if (bytes.toString("base64") !== request.payload) return yield* BrowserFileExchange.failure("BROWSER_FILE_INVALID")
                yield* file.writeDownload(transfer, { artifactID: request.artifactID, offset: request.offset, bytes })
                return { type: "file.leaf.response" as const, id: request.id }
              }
              if (request.operation === "upload.seal") {
                yield* file.sealUpload(transfer, request)
                return { type: "file.leaf.response" as const, id: request.id }
              }
              const observed = yield* request.operation === "upload.observe" ? file.observeUpload(transfer, request) : file.publishDownload(transfer, request)
              const publication = file.describe(observed)
              if (!publication) return yield* BrowserFileExchange.failure()
              if (!file.recordObservation) return yield* BrowserFileExchange.failure()
              yield* file.recordObservation(transfer, request.artifactID, observed)
              completed.set(request.artifactID, observed)
              return { type: "file.leaf.response" as const, id: request.id, publication }
            }))
            return response
          } catch (error) {
            return { type: "file.leaf.response", id: request.id,
              error: error instanceof BrowserFileSchema.Error ? error.code : "BROWSER_FILE_UNKNOWN" }
          } finally { owned.busy = false }
        } : undefined
      const response = yield* rpc({ type: "execute", id: crypto.randomUUID(), control, action, ...(files ? { files } : {}) }, check, leaf).pipe(
        Effect.onInterrupt(() => cancel(control).pipe(Effect.catch(() => Effect.void), Effect.uninterruptible)),
        Effect.tapError(() => transfer && Option.isSome(capability) && capability.value.unknownAction ? capability.value.unknownAction(transfer)
          .pipe(Effect.catch(() => Effect.void)) : Effect.void),
      )
      if (!response.result) return yield* BrowserControl.failure("BROWSER_UNKNOWN")
      if (transfer && files && Option.isSome(capability)) {
        if (completed.size !== files.length) return yield* BrowserControl.failure("BROWSER_UNKNOWN")
        const expected = files.map((entry) => {
          const observed = completed.get(entry.artifact.artifactID)
          const publication = observed && capability.value.describe(observed)
          return publication ? { artifactID: publication.artifactID, grantID: publication.grantID,
            direction: publication.direction, name: entry.grant.preview.name, bytes: publication.bytes,
            sha256: publication.sha256, state: publication.outcome, nativeVerified: true } : null
        })
        if (expected.some((value) => !value) || BrowserControl.hash(expected) !== BrowserControl.hash(response.result.files))
          return yield* BrowserControl.failure("BROWSER_UNKNOWN")
        // Main returns success only after clearing the exact FileList and removing its own stages.
        // The canonical tool observes its terminal first, then releases the captured cleanup receipt.
        yield* capability.value.cleanup(transfer).pipe(Effect.mapError(() => BrowserControl.failure("BROWSER_UNKNOWN")))
      }
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
