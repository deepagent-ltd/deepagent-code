export * as BrowserFiles from "./file-exchange"

import fs from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { Context, Deferred, Effect, Exit, Layer, Option, Schema, Scope } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { BrowserHost } from "@deepagent-code/core/browser/host"
import { BrowserControl } from "@deepagent-code/core/browser/control"
import { BrowserFileControl } from "@deepagent-code/core/browser/file-control"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { BrowserFileCapability } from "@deepagent-code/core/browser/file-capability"
import { BrowserFileExchange } from "@deepagent-code/core/browser/file-exchange"
import { BrowserFileSchema } from "@deepagent-code/core/browser/file-exchange.schema"
import { WorkFileHelper } from "../installation/work-file-helper"

const fail = BrowserFileExchange.failure
const hash = BrowserFileExchange.hash
const WireIdentity = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("posix"), device: Schema.String, inode: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("windows"), volume_serial: Schema.String, file_id: Schema.String }),
])
const Observation = Schema.Struct({ identity: WireIdentity, offset: BrowserFileSchema.Count,
  file_bytes: BrowserFileSchema.FileBytes, scanned_bytes: BrowserFileSchema.FileBytes,
  observed_sha256: BrowserFileSchema.Digest, page_sha256: BrowserFileSchema.Digest,
  snapshot: Schema.Literal("stream_observation") })
const Reply = Schema.Struct({ version: Schema.Literal(1), id: Schema.String,
  status: Schema.Literals(["ready", "observed", "refused", "closed", "missing", "prepared", "published", "unknown", "cleaned"]),
  code: Schema.NullOr(Schema.Literals(["FILE_SCOPE_UNAVAILABLE", "WRITE_OUTCOME_UNKNOWN"])), root: Schema.NullOr(WireIdentity),
  observation: Schema.NullOr(Observation), payload_bytes: BrowserFileSchema.Count,
  capture_id: Schema.optional(Schema.String), binary_complete: Schema.optional(Schema.Boolean),
  destination_parent: Schema.optional(WireIdentity),
  preparation: Schema.optional(Schema.Struct({ parent: WireIdentity, stage: WireIdentity })),
  write: Schema.optional(Schema.Struct({ parent: WireIdentity, stage: WireIdentity, file: WireIdentity,
    sha256: BrowserFileSchema.Digest, bytes: BrowserFileSchema.FileBytes, previous: Schema.Struct({ kind: Schema.Literal("missing") }),
    publication: Schema.Literal("optimistic_namespace_publish") })),
})
type Asset = Effect.Success<ReturnType<typeof WorkFileHelper.browserAsset>>
type Response = { value: typeof Reply.Type; bytes: Buffer }
type Native = { child: ChildProcessWithoutNullStreams; exited: Promise<void>; stopped: boolean; live: boolean; closing?: Promise<void>;
  buffer: Buffer; pending?: { id: string; resolve: (value: Response) => void; reject: (error: BrowserFileSchema.Error) => void } }
type Leaf = { artifact: BrowserFileSchema.Artifact; grant: BrowserFileSchema.Grant; process: Native;
  stage: string; stageIdentity: BrowserFileSchema.Identity; file: FileHandle; fileIdentity: BrowserFileSchema.Identity;
  offset: number; stream: ReturnType<typeof createHash>; captureID?: string; complete: boolean; publication?: BrowserFileCapability.Observation;
  unknown: boolean; cleaned: boolean; sealed: boolean; fileClosed?: boolean }
type Transfer = { active: boolean; asset: Asset; leaves: Map<string, Leaf>; processes: Set<Native>; retiring?: Promise<void>; current: () => Promise<void> }

function fromWire(value: typeof WireIdentity.Type): BrowserFileSchema.Identity {
  return value.kind === "posix" ? value : { kind: "windows", volumeSerial: value.volume_serial, fileID: value.file_id }
}
function wire(value: BrowserFileSchema.Identity) {
  return value.kind === "posix" ? value : { kind: "windows", volume_serial: value.volumeSerial, file_id: value.fileID }
}
function identity(stat: Awaited<ReturnType<typeof fs.lstat>> & { dev: number | bigint; ino: number | bigint }): BrowserFileSchema.Identity {
  if (process.platform === "win32") throw fail()
  return { kind: "posix", device: String(stat.dev), inode: String(stat.ino) }
}
async function open(asset: Asset, directory: string, expected: BrowserFileSchema.Identity, captured: (entry: Native) => void) {
  await Effect.runPromise(asset.current)
  const child = spawn(asset.filename, [], { cwd: path.dirname(asset.filename), env: {}, stdio: ["pipe", "pipe", "pipe"] })
  const entry: Native = { child, exited: new Promise<void>((resolve) => child.once("close", resolve)), stopped: false, live: true, buffer: Buffer.alloc(0) }
  child.once("close", () => { entry.stopped = true })
  captured(entry)
  child.stderr.resume()
  const refused = () => { entry.live = false; entry.pending?.reject(fail("BROWSER_FILE_UNKNOWN")); entry.pending = undefined }
  child.once("error", refused)
  child.once("close", refused)
  child.stdout.on("data", (data: Buffer) => {
    if (!entry.live || !entry.pending || entry.buffer.length + data.length > 65_536 + 4 + BrowserFileSchema.CHUNK_BYTES) { refused(); child.kill(); return }
    entry.buffer = Buffer.concat([entry.buffer, data])
    if (entry.buffer.length < 4) return
    const length = entry.buffer.readUInt32BE(0)
    if (length === 0 || length > 65_536) { refused(); child.kill(); return }
    if (entry.buffer.length < length + 4) return
    const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Reply), { onExcessProperty: "error" })(entry.buffer.subarray(4, length + 4).toString("utf8"))
    if (Option.isNone(decoded) || decoded.value.id !== entry.pending.id || decoded.value.payload_bytes > BrowserFileSchema.CHUNK_BYTES) {
      refused(); child.kill(); return
    }
    const end = length + 4 + decoded.value.payload_bytes
    if (entry.buffer.length < end) return
    if (entry.buffer.length !== end) { refused(); child.kill(); return }
    const pending = entry.pending
    const bytes = entry.buffer.subarray(length + 4, end)
    entry.buffer = Buffer.alloc(0)
    entry.pending = undefined
    pending.resolve({ value: decoded.value, bytes })
  })
  try {
    const ready = await request(entry, { op: "open_root", path: directory, expected: wire(expected) })
    if (ready.value.status !== "ready" || !ready.value.root || hash(fromWire(ready.value.root)) !== hash(expected)) throw fail("BROWSER_FILE_CHANGED")
    return entry
  } catch (error) { await close(entry); throw error }
}
async function request(entry: Native, body: Record<string, unknown>, deadline = Date.now() + 10_000): Promise<Response> {
  if (!entry.live || entry.pending || deadline <= Date.now()) throw fail("BROWSER_FILE_CHANGED")
  return new Promise<Response>((resolve, reject) => {
    const id = randomUUID()
    const timer = setTimeout(() => {
      if (entry.pending?.id !== id) return
      entry.pending = undefined; entry.live = false; entry.child.kill("SIGKILL"); reject(fail("BROWSER_FILE_UNKNOWN"))
    }, Math.min(30_000, deadline - Date.now()))
    entry.pending = { id, resolve: (value) => { clearTimeout(timer); resolve(value) }, reject: (error) => { clearTimeout(timer); reject(error) } }
    const data = Buffer.from(JSON.stringify({ version: 1, id, ...body }))
    if (data.length > 65_536) { entry.pending = undefined; clearTimeout(timer); reject(fail()); return }
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length)
    entry.child.stdin.write(Buffer.concat([size, data]), (error) => {
      if (!error || entry.pending?.id !== id) return
      entry.pending = undefined; clearTimeout(timer); reject(fail("BROWSER_FILE_UNKNOWN"))
    })
  })
}
function close(entry: Native) {
  // Only the first close owns native dispatch. Unknown retains this exact promise and child;
  // a later original close event is an observation, never a fresh kill or replay.
  entry.closing ??= (async () => {
    if (entry.live && !entry.pending) await request(entry, { op: "close" }).catch(() => undefined)
    entry.live = false
    if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill("SIGKILL")
    const timer = { value: undefined as ReturnType<typeof setTimeout> | undefined }
    const stopped = await Promise.race([entry.exited.then(() => true), new Promise<false>((resolve) => {
      timer.value = setTimeout(() => resolve(false), 1000)
    })]).finally(() => clearTimeout(timer.value))
    if (!stopped) throw fail("BROWSER_FILE_UNKNOWN")
  })()
  return entry.closing
}
async function rootIdentity(directory: string) {
  if (process.platform !== "darwin" && process.platform !== "linux" || !path.isAbsolute(directory) || await fs.realpath(directory) !== directory) throw fail()
  const stat = await fs.lstat(directory, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail("BROWSER_FILE_CHANGED")
  return { kind: "posix" as const, device: String(stat.dev), inode: String(stat.ino) }
}
async function privateStage(directory: string, expected: BrowserFileSchema.Identity) {
  const parent = path.dirname(directory)
  if (expected.kind !== "posix" || await fs.realpath(parent) !== parent) throw fail()
  const stage = await fs.mkdtemp(path.join(parent, ".dac-browser-file-"))
  await fs.chmod(stage, 0o700)
  const stat = await fs.lstat(stage, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || String(stat.dev) !== expected.device || stat.uid !== BigInt(process.getuid?.() ?? -1) || (stat.mode & 0o077n) !== 0n) throw fail()
  const file = await fs.open(path.join(stage, "payload"), "wx+", 0o600)
  return { stage, stageIdentity: identity(stat), file, fileIdentity: identity(await file.stat({ bigint: true })) }
}

export interface Interface {
  readonly preview: (input: { controlID: string; scope: BrowserSchema.Scope; request: BrowserFileSchema.PreviewRequest }) =>
    Effect.Effect<{ previewID: string; preview: BrowserFileSchema.Preview }, BrowserFileSchema.Error>
  readonly approve: (input: { controlID: string; scope: BrowserSchema.Scope; command: BrowserFileSchema.Approve }) =>
    Effect.Effect<{ grant: BrowserFileSchema.GrantSummary; replayed: boolean }, BrowserFileSchema.Error>
  readonly status: (input: { controlID: string; scope: BrowserSchema.Scope; requestID: string }) =>
    Effect.Effect<{ requestID: string; state: BrowserFileSchema.GrantSummary["state"] | "missing"; grant: BrowserFileSchema.GrantSummary | null }, BrowserFileSchema.Error>
  readonly list: (input: { controlID: string; scope: BrowserSchema.Scope; cursor?: string; limit?: number }) =>
    Effect.Effect<{ files: (typeof BrowserFileSchema.Summary.Type)[]; grants: BrowserFileSchema.GrantSummary[]; nextCursor: string | null }, BrowserFileSchema.Error>
}
export class Service extends Context.Service<Service, Interface>()("@deepagent-code/BrowserFiles") {}

/** Captured once in the existing Root. The factory accepts no path, helper, resolver, CA or authority callback from callers. */
export const layer = Layer.unwrap(Effect.gen(function* () {
  const database = yield* Database.Service
  const host = yield* BrowserHost.Current
  const scope = yield* Effect.scope
  const previews = new WeakMap<BrowserFileCapability.Preview, { control: BrowserSchema.Control; request: BrowserFileSchema.PreviewRequest;
    description: BrowserFileSchema.Preview; asset: Asset }>()
  const approvals = new WeakMap<BrowserFileCapability.Approval, { preview: BrowserFileCapability.Preview;
    commandHash: string; confirmation: BrowserFileSchema.Confirmation }>()
  const grants = new Map<string, string>()
  const transfers = new WeakMap<BrowserFileCapability.Transfer, Transfer>()
  const observations = new WeakMap<BrowserFileCapability.Observation, BrowserFileSchema.Publication>()
  const released = new WeakMap<BrowserFileCapability.Released, readonly string[]>()
  const active = new Set<Transfer>()
  const cleanupReceipts = new Map<string, { artifacts: BrowserFileSchema.Artifact[]; confirmation: BrowserFileCapability.Released }>()
  const observing = new Set<{ process?: Native; control: BrowserSchema.Control; input: BrowserFileSchema.PreviewRequest; asset?: Asset }>()
  const state = { live: true, opening: 0, previewing: 0 }
  const retireTransfer = (transfer: Transfer) => {
    if (transfer.active || [...transfer.processes].some((entry) => !entry.stopped) ||
      [...transfer.leaves.values()].some((leaf) => !leaf.fileClosed)) return
    active.delete(transfer)
  }
  const closeTransfer = (transfer: Transfer) => {
    transfer.active = false
    transfer.retiring ??= Promise.allSettled([...transfer.leaves.values()].map(async (leaf) => {
      await leaf.file.close()
      leaf.fileClosed = true
    })).then(async () => {
      await Promise.allSettled([...transfer.processes].map(close))
      // Retire only known original handles. Unknown stays strongly owned and occupies its slot.
      retireTransfer(transfer)
    })
    return transfer.retiring
  }
  const wrapped = <A>(body: () => Promise<A>) => Effect.tryPromise({ try: body,
    catch: (error) => error instanceof BrowserFileSchema.Error ? error : fail() })
  const currentControl = (control: BrowserSchema.Control) => Effect.gen(function* () {
    if (!state.live || !host?.alive() || !host.verify(control).matched || host.verify(control).stopped) return yield* fail()
    const actual = yield* BrowserControl.requireActive(database.db, control.controlID, control.scope, host).pipe(Effect.mapError(() => fail("BROWSER_FILE_CHANGED")))
    if (hash(actual) !== hash(control)) return yield* fail("BROWSER_FILE_CHANGED")
  })
  const observe = async (control: BrowserSchema.Control, input: BrowserFileSchema.PreviewRequest, priorAsset?: Asset) => {
    if (!state.live) throw fail("BROWSER_FILE_CHANGED")
    if (state.opening + active.size >= 8) throw fail("BROWSER_FILE_CAPACITY")
    // Reserve synchronously before the first filesystem/native await.
    state.opening++
    const reservation = { control, input, asset: priorAsset, process: undefined as Native | undefined }
    observing.add(reservation)
    const release = () => { if (observing.delete(reservation)) state.opening-- }
    try {
      await Effect.runPromise(currentControl(control))
      const asset = priorAsset ?? await Effect.runPromise(WorkFileHelper.browserAsset())
      reservation.asset = asset
      const root = await rootIdentity(control.scope.directory)
      const process = await open(asset, control.scope.directory, root, (entry) => {
        reservation.process = entry
        void entry.exited.then(release)
      })
      const reply = await request(process, { op: input.direction === "upload" ? "observe_binary" : "inspect_binary_destination",
        relative: input.relative, ...(input.direction === "upload" ? { scan_limit: BrowserFileSchema.MAX_FILE_BYTES } : {}), deadline_ms: 30_000 })
      await Effect.runPromise(currentControl(control))
      await Effect.runPromise(asset.current)
      const common = { version: 1 as const, instanceID: asset.instanceID, controlID: control.controlID, controlHash: hash(control),
        scopeHash: hash(control.scope), helperHash: asset.helperHash, rootIdentity: root, relative: input.relative,
        name: path.posix.basename(input.relative), observedAt: Date.now() }
      if (input.direction === "upload") {
        if (reply.value.status !== "observed" || !reply.value.observation || reply.bytes.length !== 0) throw fail("BROWSER_FILE_CHANGED")
        return { asset, description: { ...common, direction: input.direction, targetPath: input.targetPath, fileIdentity: fromWire(reply.value.observation.identity),
          bytes: reply.value.observation.file_bytes, sha256: reply.value.observation.observed_sha256 } }
      }
      if (reply.value.status !== "missing" || !reply.value.destination_parent || reply.bytes.length !== 0) throw fail("BROWSER_FILE_CHANGED")
      return { asset, description: { ...common, direction: input.direction, targetURL: input.targetURL, parentIdentity: fromWire(reply.value.destination_parent),
        maxBytes: input.maxBytes, expected: "missing" as const } }
    } finally {
      if (reservation.process) await close(reservation.process)
      // No spawned child, or its original close already confirmed: the reservation is known.
      if (!reservation.process || reservation.process.stopped) release()
    }
  }
  const lookup = (handle: BrowserFileCapability.Transfer, artifactID: string) => {
    const transfer = transfers.get(handle)
    const leaf = transfer?.leaves.get(artifactID)
    if (!transfer?.active || !leaf || leaf.cleaned || leaf.unknown) throw fail("BROWSER_FILE_CHANGED")
    return { transfer, leaf }
  }
  const native: BrowserFileCapability.Interface = {
    preview: (input) => Effect.gen(function* () {
      const observed = yield* wrapped(() => observe(input.control, input.request))
      const handle = Object.freeze({}) as BrowserFileCapability.Preview
      previews.set(handle, { control: input.control, request: input.request, description: observed.description, asset: observed.asset })
      return handle
    }),
    describePreview: (handle, input) => {
      const prior = previews.get(handle)
      return state.live && prior && hash(prior.control) === hash(input.control) && hash(prior.request) === hash(input.request) ? prior.description : undefined
    },
    currentPreview: (handle) => wrapped(async () => {
      const prior = previews.get(handle)
      if (!prior) throw fail("BROWSER_FILE_CHANGED")
      const observed = await observe(prior.control, prior.request, prior.asset)
      if (hash({ ...observed.description, observedAt: prior.description.observedAt }) !== hash(prior.description)) throw fail("BROWSER_FILE_CHANGED")
    }),
    confirm: (handle, command) => Effect.gen(function* () {
      const prior = previews.get(handle)
      if (!prior || !host?.confirmFiles) return yield* fail()
      yield* native.currentPreview(handle)
      const confirmation = yield* host.confirmFiles(prior.control, prior.description, command, native.currentPreview(handle))
      if (confirmation.previewHash !== hash(prior.description) || confirmation.commandHash !== hash(command)) return yield* fail("BROWSER_FILE_CHANGED")
      const approved = Object.freeze({}) as BrowserFileCapability.Approval
      approvals.set(approved, { preview: handle, commandHash: hash(command), confirmation })
      return approved
    }),
    approved: (handle, preview, command) => state.live && approvals.get(handle)?.preview === preview && approvals.get(handle)?.commandHash === hash(command),
    describeApproval: (handle) => state.live ? approvals.get(handle)?.confirmation : undefined,
    acceptGrant: (handle, approval, grant) => {
      const prior = previews.get(handle)
      const allowed = approvals.get(approval)
      if (!state.live || !prior || !allowed || allowed.preview !== handle || hash(grant.preview) !== hash(prior.description) ||
        grant.commandHash !== allowed.commandHash || hash(grant.confirmation) !== hash(allowed.confirmation) || grants.has(grant.grantID)) return false
      grants.set(grant.grantID, hash(grant)); return true
    },
    prepare: (input) => Effect.gen(function* () {
      if (!host || !state.live) return yield* fail()
      if (state.opening + active.size >= 8) return yield* fail("BROWSER_FILE_CAPACITY")
      state.opening++
      const reservation = { pending: true }
      return yield* Effect.gen(function* () {
      const control = yield* BrowserFileControl.capture(database.db, input.control, host)
        .pipe(Effect.mapError(() => fail("BROWSER_FILE_CHANGED")))
      yield* input.current
      if (input.grants.length < 1 || input.grants.length > 4 || input.artifacts.length !== input.grants.length)
        return yield* fail("BROWSER_FILE_CAPACITY")
      const asset = yield* WorkFileHelper.browserAsset()
      const context = yield* Effect.context<never>()
      const transfer: Transfer = { active: true, asset, leaves: new Map(), processes: new Set(), current: async () => {
        if (!state.live || !transfer.active || input.action.deadline <= Date.now() || input.grants.some((grant) => grant.expiresAt <= Date.now()))
          throw fail("BROWSER_FILE_CHANGED")
        await Effect.runPromiseWith(context)(input.current)
        await Effect.runPromise(BrowserFileControl.requireCurrent(database.db, control)
          .pipe(Effect.mapError(() => fail("BROWSER_FILE_CHANGED"))))
      } }
      active.add(transfer)
      state.opening--
      reservation.pending = false
      yield* Effect.addFinalizer(() => wrapped(() => closeTransfer(transfer)).pipe(Effect.catch(() => Effect.void)))
      for (const [ordinal, grant] of input.grants.entries()) {
        const artifact = input.artifacts[ordinal]!
        if (grants.get(grant.grantID) !== hash(grant) || grant.instanceID !== asset.instanceID ||
          grant.expiresAt <= Date.now() || artifact.state !== "reserved" || artifact.ordinal !== ordinal || artifact.releasedAt !== null ||
          artifact.actionID !== input.action.actionID || artifact.grantHash !== hash(grant) || hash(artifact.manifest) !== hash(grant.preview) ||
          hash(artifact.manifest.rootIdentity) !== hash(yield* wrapped(() => rootIdentity(input.control.scope.directory)))) return yield* fail("BROWSER_FILE_CHANGED")
        const process = yield* Effect.acquireRelease(wrapped(() => open(asset, input.control.scope.directory, grant.preview.rootIdentity, (entry) => {
          transfer.processes.add(entry)
          void entry.exited.then(() => retireTransfer(transfer))
        })),
          (entry) => wrapped(() => close(entry)).pipe(Effect.catch(() => Effect.void)))
        const stage = yield* wrapped(() => privateStage(input.control.scope.directory, grant.preview.rootIdentity))
        const leaf: Leaf = { artifact, grant, process, ...stage, offset: 0, stream: createHash("sha256"), complete: false, unknown: false, cleaned: false, sealed: false }
        transfer.leaves.set(artifact.artifactID, leaf)
        const preview = grant.preview
        if (preview.direction === "upload") {
          const opened = yield* wrapped(() => request(process, { op: "open_binary", relative: preview.relative,
            expected: { kind: "observed", identity: wire(preview.fileIdentity), bytes: preview.bytes, sha256: preview.sha256 },
            deadline_ms: Math.max(1, Math.min(30_000, input.action.deadline - Date.now())) }, input.action.deadline))
          if (opened.value.status !== "observed" || !opened.value.capture_id) return yield* fail("BROWSER_FILE_CHANGED")
          leaf.captureID = opened.value.capture_id
        }
      }
      const handle = Object.freeze({}) as BrowserFileCapability.Transfer
      transfers.set(handle, transfer)
      return handle
      }).pipe(Effect.ensuring(Effect.sync(() => { if (reservation.pending) state.opening-- })))
    }),
    current: (handle) => wrapped(async () => { const transfer = transfers.get(handle); if (!transfer) throw fail(); await transfer.current() }),
    readUpload: (handle, input) => wrapped(async () => {
      const { transfer, leaf } = lookup(handle, input.artifactID)
      await transfer.current()
      const preview = leaf.grant.preview
      if (preview.direction !== "upload" || !leaf.captureID || input.offset !== leaf.offset || !Number.isSafeInteger(input.bytes) ||
        input.bytes < 1 || input.bytes > BrowserFileSchema.CHUNK_BYTES || leaf.complete) throw fail("BROWSER_FILE_CHANGED")
      const reply = await request(leaf.process, { op: "read_binary", capture_id: leaf.captureID, offset: input.offset,
        length: input.bytes, deadline_ms: 30_000 })
      const observation = reply.value.observation
      if (reply.value.status !== "observed" || !observation || observation.offset !== input.offset || observation.file_bytes !== preview.bytes ||
        observation.observed_sha256 !== preview.sha256 || hash(fromWire(observation.identity)) !== hash(preview.fileIdentity) ||
        observation.page_sha256 !== createHash("sha256").update(reply.bytes).digest("hex")) throw fail("BROWSER_FILE_CHANGED")
      const written = await leaf.file.write(reply.bytes, 0, reply.bytes.length, input.offset)
      if (written.bytesWritten !== reply.bytes.length) throw fail("BROWSER_FILE_UNKNOWN")
      leaf.stream.update(reply.bytes); leaf.offset += reply.bytes.length; leaf.complete = reply.value.binary_complete === true
      if (leaf.complete && (leaf.offset !== preview.bytes || leaf.stream.copy().digest("hex") !== preview.sha256)) throw fail("BROWSER_FILE_CHANGED")
      await transfer.current()
      return reply.bytes
    }),
    writeDownload: (handle, input) => wrapped(async () => {
      const { transfer, leaf } = lookup(handle, input.artifactID)
      await transfer.current()
      const preview = leaf.grant.preview
      if (preview.direction !== "download" || leaf.complete || input.offset !== leaf.offset || input.bytes.length > BrowserFileSchema.CHUNK_BYTES ||
        input.bytes.length === 0 || input.offset + input.bytes.length > preview.maxBytes) throw fail("BROWSER_FILE_CHANGED")
      if ((await leaf.file.write(input.bytes, 0, input.bytes.length, input.offset)).bytesWritten !== input.bytes.length) throw fail("BROWSER_FILE_UNKNOWN")
      leaf.stream.update(input.bytes); leaf.offset += input.bytes.length
      await transfer.current()
    }),
    sealUpload: (handle, input) => wrapped(async () => {
      const { transfer, leaf } = lookup(handle, input.artifactID)
      await transfer.current()
      await Effect.runPromise(transfer.asset.current)
      const preview = leaf.grant.preview
      if (preview.direction !== "upload" || !leaf.complete || leaf.sealed || !leaf.captureID || input.bytes !== preview.bytes || input.sha256 !== preview.sha256)
        throw fail("BROWSER_FILE_CHANGED")
      await leaf.file.sync()
      const before = await leaf.file.stat({ bigint: true })
      const digest = createHash("sha256")
      const buffer = Buffer.alloc(65_536)
      let offset = 0
      while (offset < input.bytes) {
        const read = await leaf.file.read(buffer, 0, Math.min(buffer.length, input.bytes - offset), offset)
        if (read.bytesRead === 0) throw fail("BROWSER_FILE_CHANGED")
        digest.update(buffer.subarray(0, read.bytesRead)); offset += read.bytesRead
      }
      const after = await leaf.file.stat({ bigint: true })
      const named = await fs.lstat(path.join(leaf.stage, "payload"), { bigint: true })
      const stamp = (value: typeof before) => [value.dev, value.ino, value.size, value.mode, value.nlink, value.mtimeNs, value.ctimeNs].join(":")
      if (stamp(before) !== stamp(after) || stamp(after) !== stamp(named) || before.size !== BigInt(input.bytes) || digest.digest("hex") !== input.sha256)
        throw fail("BROWSER_FILE_CHANGED")
      const sealed = await request(leaf.process, { op: "seal_binary", capture_id: leaf.captureID, deadline_ms: 30_000 })
      if (sealed.value.status !== "observed" || !sealed.value.observation || sealed.value.binary_complete !== true ||
        sealed.value.observation.observed_sha256 !== input.sha256 || sealed.value.observation.file_bytes !== input.bytes ||
        hash(fromWire(sealed.value.observation.identity)) !== hash(preview.fileIdentity)) throw fail("BROWSER_FILE_CHANGED")
      await transfer.current()
      leaf.sealed = true
    }),
    observeUpload: (handle, input) => wrapped(async () => {
      const { transfer, leaf } = lookup(handle, input.artifactID)
      await transfer.current()
      const preview = leaf.grant.preview
      if (preview.direction !== "upload" || !leaf.complete || !leaf.sealed || leaf.publication || input.bytes !== preview.bytes || input.sha256 !== preview.sha256)
        throw fail("BROWSER_FILE_CHANGED")
      await leaf.file.sync()
      const stat = await leaf.file.stat({ bigint: true })
      if (stat.size !== BigInt(preview.bytes) || hash(identity(stat)) !== hash(leaf.fileIdentity)) throw fail("BROWSER_FILE_CHANGED")
      const observed = Object.freeze({}) as BrowserFileCapability.Observation
      observations.set(observed, { version: 1, artifactID: leaf.artifact.artifactID, grantID: leaf.grant.grantID,
        direction: "upload", rootIdentity: preview.rootIdentity, stageIdentity: leaf.stageIdentity, fileIdentity: preview.fileIdentity,
        bytes: input.bytes, sha256: input.sha256, helperHash: preview.helperHash, observedAt: Date.now(), outcome: "selected" })
      leaf.publication = observed
      return observed
    }),
    publishDownload: (handle, input) => wrapped(async () => {
      const { transfer, leaf } = lookup(handle, input.artifactID)
      await transfer.current()
      await Effect.runPromise(transfer.asset.current)
      const preview = leaf.grant.preview
      if (preview.direction !== "download" || leaf.complete || leaf.publication || input.bytes !== leaf.offset ||
        input.bytes > preview.maxBytes || input.sha256 !== leaf.stream.copy().digest("hex")) throw fail("BROWSER_FILE_CHANGED")
      leaf.complete = true
      await leaf.file.sync()
      // Publication is one-shot even after a lost reply. The retained charge survives unknown custody.
      const prepared = await request(leaf.process, { op: "prepare_binary_write", relative: preview.relative,
        stage: leaf.stage, stage_identity: wire(leaf.stageIdentity), bytes: input.bytes, sha256: input.sha256,
        expected: { kind: "missing" }, deadline_ms: 30_000 })
      if (prepared.value.status !== "prepared" || !prepared.value.preparation ||
        hash(fromWire(prepared.value.preparation.parent)) !== hash(preview.parentIdentity)) throw fail("BROWSER_FILE_CHANGED")
      leaf.unknown = true
      const published = await request(leaf.process, { op: "publish_write", prepared_id: prepared.value.id })
      if (published.value.status !== "published" || !published.value.write) throw fail("BROWSER_FILE_UNKNOWN")
      const write = published.value.write
      if (write.bytes !== input.bytes || write.sha256 !== input.sha256 || hash(fromWire(write.parent)) !== hash(preview.parentIdentity) ||
        hash(fromWire(write.stage)) !== hash(leaf.stageIdentity) || hash(fromWire(write.file)) !== hash(leaf.fileIdentity)) throw fail("BROWSER_FILE_UNKNOWN")
      const observed = Object.freeze({}) as BrowserFileCapability.Observation
      observations.set(observed, { version: 1, artifactID: leaf.artifact.artifactID, grantID: leaf.grant.grantID,
        direction: "download", rootIdentity: preview.rootIdentity, stageIdentity: leaf.stageIdentity, fileIdentity: fromWire(write.file),
        bytes: write.bytes, sha256: write.sha256, helperHash: preview.helperHash, observedAt: Date.now(), outcome: "published" })
      leaf.unknown = false; leaf.publication = observed
      return observed
    }),
    describe: (handle) => observations.get(handle),
    cleanup: (handle) => wrapped(async () => {
      const transfer = transfers.get(handle)
      if (!transfer || [...transfer.leaves.values()].some((leaf) => leaf.unknown)) throw fail("BROWSER_FILE_UNKNOWN")
      for (const leaf of transfer.leaves.values()) {
        if (leaf.cleaned) throw fail("BROWSER_FILE_CONFLICT")
        const cleaned = await request(leaf.process, { op: "cleanup_binary_stage", stage: leaf.stage, stage_identity: wire(leaf.stageIdentity) })
        if (cleaned.value.status !== "cleaned") throw fail("BROWSER_FILE_UNKNOWN")
        await leaf.file.close()
        leaf.fileClosed = true
        if (hash(await rootIdentity(leaf.stage)) !== hash(leaf.stageIdentity)) throw fail("BROWSER_FILE_CHANGED")
        await fs.rmdir(leaf.stage)
        await close(leaf.process)
        leaf.cleaned = true
      }
      transfer.active = false; retireTransfer(transfer)
      const value = Object.freeze({}) as BrowserFileCapability.Released
      released.set(value, [...transfer.leaves.keys()])
      const artifacts = [...transfer.leaves.values()].map((leaf) => leaf.artifact)
      cleanupReceipts.set(artifacts[0]!.actionID, { artifacts, confirmation: value })
      return value
    }),
    describeReleased: (handle) => released.get(handle),
    executionFiles: (input) => Effect.gen(function* () {
      const files = yield* BrowserFileExchange.actionFiles(database.db, input.action)
      const transfer = yield* native.prepare({ ...input, grants: files.map((entry) => entry.grant), artifacts: files.map((entry) => entry.artifact) })
      return { files, transfer }
    }),
    recordObservation: (handle, artifactID, observation) => Effect.gen(function* () {
      const owned = transfers.get(handle)?.leaves.get(artifactID)
      if (!owned || owned.publication !== observation) return yield* fail("BROWSER_FILE_CHANGED")
      owned.artifact = yield* BrowserFileExchange.observed(database.db, owned.artifact, observation)
        .pipe(Effect.provideService(BrowserFileCapability.Service, native))
    }),
    unknownAction: (handle) => Effect.gen(function* () {
      const transfer = transfers.get(handle)
      if (!transfer) return yield* fail()
      for (const leaf of transfer.leaves.values()) {
        if (leaf.artifact.state === "reserved" || leaf.artifact.state === "staged")
          leaf.artifact = yield* BrowserFileExchange.unknown(database.db, leaf.artifact)
      }
    }),
    finishAction: (actionID) => Effect.gen(function* () {
      const receipt = cleanupReceipts.get(actionID)
      if (!receipt) return yield* fail("BROWSER_FILE_UNKNOWN")
      yield* BrowserFileExchange.released(database.db, receipt.artifacts, receipt.confirmation)
        .pipe(Effect.provideService(BrowserFileCapability.Service, native))
      cleanupReceipts.delete(actionID)
    }),
    listFiles: (input) => api.list(input),
  }
  yield* Scope.addFinalizer(scope, Effect.promise(async () => {
    state.live = false
    await Promise.allSettled([...active].map(closeTransfer))
    await Promise.allSettled([...observing].flatMap((entry) => entry.process ? [close(entry.process)] : []))
  }))
  const captures = new Map<string, BrowserFileExchange.Capture>()
  const operations = new Map<string, { commandHash: string; effect: Effect.Effect<{ grant: BrowserFileSchema.GrantSummary; replayed: boolean }, BrowserFileSchema.Error> }>()
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provideService(BrowserFileCapability.Service, native))
  const projection = (grant: BrowserFileSchema.Grant, artifact?: BrowserFileSchema.Artifact) => Effect.gen(function* () {
    const control = yield* BrowserControl.get(database.db, grant.controlID).pipe(Effect.mapError(() => fail()))
    const summary: BrowserFileSchema.GrantSummary = { grantID: grant.grantID, direction: grant.preview.direction, name: grant.preview.name,
      ...(grant.preview.direction === "upload" ? { bytes: grant.preview.bytes } : { maxBytes: grant.preview.maxBytes }),
      expiresAt: grant.expiresAt, state: artifact ? "used" : grant.expiresAt <= Date.now() ? "expired" :
        state.live && grants.get(grant.grantID) === hash(grant) && control && control.state === "active" && !control.cancel &&
        control.epoch === grant.controlEpoch && control.policyRevision === grant.policyRevision && host?.alive() && host.verify(control).matched &&
        !host.verify(control).stopped ? "approved" : "unavailable" }
    return summary
  })
  const api: Interface = {
    preview: (input) => provide(Effect.gen(function* () {
      if (!state.live || captures.size + state.previewing >= 64) return yield* fail("BROWSER_FILE_CAPACITY")
      state.previewing++
      return yield* Effect.gen(function* () {
        const capture = yield* BrowserFileExchange.preview(database.db, input)
        const preview = BrowserFileExchange.describePreview(capture)
        if (!state.live || !preview) return yield* fail()
        const previewID = randomUUID(); captures.set(previewID, capture)
        return { previewID, preview }
      }).pipe(Effect.ensuring(Effect.sync(() => { state.previewing-- })))
    })),
    approve: (input) => provide(Effect.gen(function* () {
      const prior = yield* BrowserFileExchange.requestGrant(database.db, { ...input, requestID: input.command.requestID })
      if (prior) {
        const result = yield* BrowserFileExchange.approve(database.db, input)
        return { grant: yield* projection(result.grant, yield* BrowserFileExchange.grantArtifact(database.db, result.grant.grantID)), replayed: result.replayed }
      }
      const key = `${input.controlID}\0${input.command.requestID}`
      const digest = hash({ scope: input.scope, command: input.command })
      const cached = operations.get(key)
      if (cached) return cached.commandHash === digest ? yield* cached.effect : yield* fail("BROWSER_FILE_CONFLICT")
      if (operations.size >= BrowserSchema.MAX_CONTROLS * BrowserFileSchema.MAX_GRANTS_PER_CONTROL) return yield* fail("BROWSER_FILE_CAPACITY")
      const completed = Deferred.makeUnsafe<Exit.Exit<{ grant: BrowserFileSchema.GrantSummary; replayed: boolean }, BrowserFileSchema.Error>>()
      const entry = { commandHash: digest, effect: Deferred.await(completed).pipe(Effect.flatMap((exit) => exit)) }
      // Publish a pending original request before any effect allocation/yield. Exact joins wait
      // on its completion; a different key must own its own bounded slot.
      operations.set(key, entry)
      return yield* provide(Effect.gen(function* () {
        const capture = captures.get(input.command.previewID)
        if (!capture) return yield* fail("BROWSER_FILE_CHANGED")
        yield* BrowserFileExchange.confirm(database.db, capture, input.command)
        const result = yield* BrowserFileExchange.approve(database.db, input, capture)
        captures.delete(input.command.previewID)
        return { grant: yield* projection(result.grant), replayed: result.replayed }
      })).pipe(Effect.onExit((exit) => Effect.sync(() => {
        Deferred.doneUnsafe(completed, Effect.succeed(exit))
      })))
    })),
    status: (input) => Effect.gen(function* () {
      const grant = yield* BrowserFileExchange.requestGrant(database.db, input)
      const summary = grant ? yield* projection(grant, yield* BrowserFileExchange.grantArtifact(database.db, grant.grantID)) : null
      return { requestID: input.requestID, state: summary?.state ?? "missing", grant: summary }
    }),
    list: (input) => Effect.gen(function* () {
      const page = yield* BrowserFileExchange.list(database.db, input)
      const summaries = yield* Effect.forEach(page.records, ({ grant, artifact }) => projection(grant, artifact))
      const files = page.records.flatMap(({ artifact }) => {
        const publication = artifact?.publication
        return publication && (artifact.state === "selected" || artifact.state === "published") ? [{
          artifactID: artifact.artifactID, grantID: artifact.grantID, direction: publication.direction, name: artifact.manifest.name,
          bytes: publication.bytes, sha256: publication.sha256, state: artifact.state, nativeVerified: true as const,
        }] : []
      })
      return { files, grants: summaries, nextCursor: page.nextCursor }
    }),
  }
  return Layer.mergeAll(Layer.succeed(BrowserFileCapability.Service, native), Layer.succeed(Service, api))
}))
