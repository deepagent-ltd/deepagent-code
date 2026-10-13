export * as EventWorkTree from "./event-work-tree"

import path from "node:path"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import type { Readable, Writable } from "node:stream"
import { Effect, Option, Schema, Scope } from "effect"
import { EventWorkDagSchema } from "@deepagent-code/core/deepagent/event-work-dag.schema"
import type { WorkAuthoritySchema } from "@deepagent-code/core/session/work-authority.schema"
import { WorkFileHelper } from "./work-file-helper"
import { NativeInstallation } from "./native-installation"
import { NativeWindowsWorkFactory } from "./windows-work-factory"

const LIMIT = 67_108_864
const MAX_FILES = 8192
const MAX_BLOB = 16_777_216
const MAX_TIME = 180_000
const Identity = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("posix"), device: Schema.String, inode: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("windows"), volume_serial: Schema.String, file_id: Schema.String }),
])
export type Identity = typeof Identity.Type
export type Leaf = { readonly relative: string; readonly bytes: Buffer; readonly executable: boolean }
const Reply = Schema.Struct({ version: Schema.Literal(1), id: Schema.String, status: Schema.String,
  code: Schema.NullOr(Schema.String), root: Schema.NullOr(Identity), payload_bytes: Schema.Literal(0),
  allocated_bytes: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(536_870_912))),
  observation: Schema.Null,
  snapshot: Schema.optional(Schema.Struct({ workspace: Identity, manifest_sha256: Schema.String,
    files: Schema.Int, bytes: Schema.Int, output_files: Schema.Literal(0) })),
})
const ObservedReply = Schema.Struct({ ...Reply.fields, payload_bytes: Schema.Int,
  observation: Schema.NullOr(Schema.Struct({ identity: Identity, offset: Schema.Int, file_bytes: Schema.Int,
    scanned_bytes: Schema.Int, observed_sha256: Schema.String, page_sha256: Schema.String, snapshot: Schema.String })),
  capture_id: Schema.optional(Schema.String), binary_complete: Schema.optional(Schema.Boolean),
})
const failure = (unknown: boolean) => new EventWorkDagSchema.Error({ code: unknown ? "EVENT_DAG_UNKNOWN" : "EVENT_DAG_UNAVAILABLE",
  message: "Original installed Native raw-tree operation is unavailable or its publication outcome is unknown" })
const capacity = { active: 0, opening: 0 }
type TreeProcess = { readonly stdin: Writable; readonly stdout: Readable; readonly stderr: Readable;
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: "close" | "error", listener: () => void): unknown }

/** Asset provenance is captured from the original Native installation. The caller must first
 * reserve Core custody/frontier and supply the exact observed private worktree identity.
 * This producer creates neither a Work nor a model or filesystem grant. */
export const make = Effect.fn("EventWorkTree.make")(function* (helperHash: string) {
  const asset = yield* treeAsset(helperHash)
  const headroom = (input: { directory: string; identity: Identity; reservationBytes: number;
    git?: { files: number; directories: number; bytes: number; index_bytes: number; existing_bytes: number } }) => Effect.gen(function* () {
    if (!path.isAbsolute(input.directory) || ![268_435_456, 536_870_912].includes(input.reservationBytes)) return yield* failure(false)
    yield* asset.current.pipe(Effect.mapError(() => failure(false)))
    const channel = yield* lease(asset, Date.now() + 10_000)
    const opened = yield* channel.send({ op: "open_root", path: input.directory, expected: input.identity }, "ready")
    if (JSON.stringify(opened.reply.root) !== JSON.stringify(input.identity)) return yield* failure(false)
    const checked = yield* channel.send({ op: "event_custody_headroom", reservation_bytes: input.reservationBytes, ...(input.git ? { git: input.git } : {}) }, "custody_ready")
    if (JSON.stringify(checked.reply.root) !== JSON.stringify(input.identity)) return yield* failure(false)
    yield* asset.current.pipe(Effect.mapError(() => failure(false)))
    yield* channel.send({ op: "close" }, "closed")
  }).pipe(Effect.scoped)
  const objectAllocation = (input: { directory: string; identity: Identity; objects: readonly string[]; maxBytes: number }) => Effect.gen(function* () {
    if (!path.isAbsolute(input.directory) || input.objects.length > 24_577 || new Set(input.objects).size !== input.objects.length ||
      input.objects.some((object) => !/^[a-f0-9]{40,64}$/.test(object)) || ![268_435_456, 536_870_912].includes(input.maxBytes)) return yield* failure(false)
    yield* asset.current.pipe(Effect.mapError(() => failure(false)))
    const channel = yield* lease(asset, Date.now() + MAX_TIME)
    const opened = yield* channel.send({ op: "open_root", path: input.directory, expected: input.identity }, "ready")
    if (JSON.stringify(opened.reply.root) !== JSON.stringify(input.identity)) return yield* failure(false)
    const total = { bytes: 0 }
    for (const relative of ["", ...new Set(input.objects.map((object) => object.slice(0, 2))), ...input.objects.map((object) => `${object.slice(0, 2)}/${object.slice(2)}`)]) {
      const observed = yield* channel.send({ op: "event_object_allocation", relative }, "object_allocated")
      if (observed.reply.allocated_bytes === undefined || JSON.stringify(observed.reply.root) !== JSON.stringify(input.identity) ||
        total.bytes + observed.reply.allocated_bytes > input.maxBytes) return yield* failure(false)
      total.bytes += observed.reply.allocated_bytes
    }
    yield* asset.current.pipe(Effect.mapError(() => failure(false)))
    yield* channel.send({ op: "close" }, "closed")
    return total.bytes
  }).pipe(Effect.scoped)
  const administrationAllocation = (input: { directory: string; identity: Identity }) => Effect.gen(function* () {
    yield* asset.current.pipe(Effect.mapError(() => failure(false)))
    const channel = yield* lease(asset, Date.now() + MAX_TIME)
    const opened = yield* channel.send({ op: "open_root", path: input.directory, expected: input.identity }, "ready")
    if (JSON.stringify(opened.reply.root) !== JSON.stringify(input.identity)) return yield* failure(false)
    const observed = yield* channel.send({ op: "event_object_allocation", relative: "@worktree" }, "object_allocated")
    if (observed.reply.allocated_bytes === undefined || JSON.stringify(observed.reply.root) !== JSON.stringify(input.identity)) return yield* failure(false)
    yield* asset.current.pipe(Effect.mapError(() => failure(false)))
    yield* channel.send({ op: "close" }, "closed")
    return observed.reply.allocated_bytes
  }).pipe(Effect.scoped)
  const collect = (input: { directory: string; identity: Identity; files: number; bytes: number; manifestSha256: string }) => Effect.gen(function* () {
    yield* asset.current.pipe(Effect.mapError(() => failure(false)))
    const channel = yield* lease(asset, Date.now() + MAX_TIME)
    const opened = yield* channel.send({ op: "open_root", path: input.directory, expected: input.identity }, "ready")
    if (JSON.stringify(opened.reply.root) !== JSON.stringify(input.identity)) return yield* failure(false)
    const observed = yield* channel.send({ op: "event_tree_collect", files: input.files, bytes: input.bytes,
      manifest_sha256: input.manifestSha256, deadline_ms: MAX_TIME }, "tree_collected")
    if (observed.reply.allocated_bytes === undefined || JSON.stringify(observed.reply.root) !== JSON.stringify(input.identity)) return yield* failure(true)
    yield* asset.current.pipe(Effect.mapError(() => failure(true)))
    yield* channel.send({ op: "close" }, "closed")
    return observed.reply.allocated_bytes
  }).pipe(Effect.scoped)
  const observe = Effect.fn("EventWorkTree.observe")(function* (input: {
    readonly directory: string; readonly identity: Identity; readonly paths: readonly string[]; readonly expiresAt: number
    readonly baselineScope?: WorkAuthoritySchema.ProjectBinding["toolPolicy"]["fileScope"]
  }) {
    if (!path.isAbsolute(input.directory) || input.paths.length > MAX_FILES || new Set(input.paths).size !== input.paths.length ||
      input.paths.some((name) => !name || Buffer.byteLength(name) > 2048 || /[\\:\u0000-\u001f\u007f]/.test(name) ||
        name.split("/").length > 32 || name.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || part.startsWith(".dac-tree-"))) ||
      input.expiresAt <= Date.now()) return yield* failure(false)
    yield* asset.current.pipe(Effect.mapError(() => failure(false)))
    const channel = yield* lease(asset, Math.min(input.expiresAt, Date.now() + MAX_TIME))
    const open = yield* channel.send({ op: "open_root", path: input.directory, expected: input.identity }, "ready")
    if (JSON.stringify(open.reply.root) !== JSON.stringify(input.identity)) return yield* failure(false)
    yield* channel.send(input.baselineScope ? { op: "event_baseline_begin", read: input.baselineScope.read, deny: input.baselineScope.deny,
      deadline_ms: Math.min(MAX_TIME, input.expiresAt - Date.now()) } : { op: "event_tree_observe_begin",
      deadline_ms: Math.min(MAX_TIME, input.expiresAt - Date.now()) }, input.baselineScope ? "baseline_observe_ready" : "tree_observe_ready")
    const names = input.baselineScope ? [] as string[] : [...input.paths]
    if (input.baselineScope) for (let page = 0; page <= MAX_FILES; page++) {
      const next = yield* channel.send({ op: "event_baseline_names", offset: names.length }, "baseline_names")
      const text = next.bytes.toString("utf8")
      if (!Buffer.from(text).equals(next.bytes) || next.bytes.byteLength && next.bytes.at(-1) !== 0 ||
        next.reply.binary_complete === undefined || JSON.stringify(next.reply.root) !== JSON.stringify(input.identity)) return yield* failure(false)
      const part = text.slice(0, Math.max(0, text.length - 1)).split("\0").filter(Boolean)
      names.push(...part)
      if (names.length > MAX_FILES || new Set(names).size !== names.length) return yield* failure(false)
      if (next.reply.binary_complete) break
      if (!part.length || page === MAX_FILES) return yield* failure(false)
    }
    const leaves: (Leaf & { readonly identity: Identity })[] = []
    const aggregate = createHash("sha256")
    const total = { bytes: 0 }
    for (const relative of names) {
      const first = yield* channel.send({ op: "event_tree_observe_leaf", relative })
      const observation = first.reply.observation
      if (!["tree_observed", "tree_observed_executable"].includes(first.reply.status) || !observation || observation.file_bytes < 0 ||
        observation.file_bytes > Math.min(MAX_BLOB, input.baselineScope?.maxReadBytes ?? MAX_BLOB, input.baselineScope?.maxHashBytes ?? MAX_BLOB) ||
        observation.scanned_bytes !== observation.file_bytes || observation.offset !== 0 ||
        !/^[a-f0-9]{64}$/.test(observation.observed_sha256) || JSON.stringify(first.reply.root) !== JSON.stringify(input.identity) ||
        total.bytes + observation.file_bytes > LIMIT) return yield* failure(false)
      const captured = yield* channel.send({ op: "open_binary", relative, expected: { kind: "observed", identity: observation.identity,
        sha256: observation.observed_sha256, bytes: observation.file_bytes }, deadline_ms: 30_000 }, "observed")
      const capture = captured.reply.capture_id
      if (!capture || captured.reply.observation?.observed_sha256 !== observation.observed_sha256) return yield* failure(false)
      const chunks: Buffer[] = []
      for (let offset = 0; offset === 0 || offset < observation.file_bytes; offset += 1_048_576) {
        const page = yield* channel.send({ op: "read_binary", capture_id: capture, offset,
          length: Math.max(1, Math.min(1_048_576, observation.file_bytes - offset)), deadline_ms: 30_000 }, "observed")
        if (!page.reply.observation || page.reply.observation.offset !== offset || page.bytes.byteLength !== Math.min(1_048_576, observation.file_bytes - offset) ||
          page.reply.observation.page_sha256 !== createHash("sha256").update(page.bytes).digest("hex") ||
          JSON.stringify(page.reply.root) !== JSON.stringify(input.identity)) return yield* failure(false)
        chunks.push(page.bytes)
      }
      const sealed = yield* channel.send({ op: "seal_binary", capture_id: capture, deadline_ms: 30_000 }, "observed")
      const bytes = Buffer.concat(chunks)
      if (!sealed.reply.binary_complete || sealed.reply.observation?.observed_sha256 !== observation.observed_sha256 ||
        bytes.byteLength !== observation.file_bytes || createHash("sha256").update(bytes).digest("hex") !== observation.observed_sha256) return yield* failure(false)
      const executable = first.reply.status === "tree_observed_executable"
      const encoded = Buffer.from(relative); const header = Buffer.alloc(4 + encoded.byteLength + 8)
      header.writeUInt32BE(encoded.byteLength); encoded.copy(header, 4); header.writeBigUInt64BE(BigInt(bytes.byteLength), 4 + encoded.byteLength)
      aggregate.update(header).update(observation.observed_sha256).update(Buffer.from([Number(executable)]))
      total.bytes += bytes.byteLength; leaves.push({ relative, bytes, executable, identity: observation.identity })
    }
    const finished = yield* channel.send({ op: "event_tree_observe_finish" }, "tree_observe_completed")
    if (!finished.reply.snapshot || finished.reply.allocated_bytes === undefined || finished.reply.snapshot.files !== leaves.length || finished.reply.snapshot.bytes !== total.bytes ||
      finished.reply.snapshot.manifest_sha256 !== aggregate.digest("hex") || JSON.stringify(finished.reply.root) !== JSON.stringify(input.identity)) return yield* failure(false)
    yield* asset.current.pipe(Effect.mapError(() => failure(false)))
    yield* channel.send({ op: "close" }, "closed")
    return { leaves, manifestSha256: finished.reply.snapshot.manifest_sha256, bytes: total.bytes, allocatedBytes: finished.reply.allocated_bytes }
  })
  const supported = Effect.gen(function* () {
    yield* asset.current.pipe(Effect.mapError(() => failure(false)))
    const channel = yield* lease(asset, Date.now() + 10_000)
    yield* channel.send({ op: "event_tree_capabilities" }, "event_tree_observation_v1")
    yield* channel.send({ op: "close" }, "closed")
  }).pipe(Effect.scoped)
  const materialize = Effect.fn("EventWorkTree.materialize")(function* (input: {
    readonly directory: string
    readonly identity: Identity
    readonly leaves: readonly Leaf[]
    readonly expiresAt: number
  }) {
    if (!path.isAbsolute(input.directory) || input.leaves.length > MAX_FILES || !Number.isSafeInteger(input.expiresAt) ||
      input.expiresAt <= Date.now() || capacity.active >= 2) return yield* failure(false)
    const names = new Set<string>()
    const aggregate = createHash("sha256")
    const leaves = input.leaves.map((leaf) => {
      const hash = createHash("sha256").update(leaf.bytes).digest("hex")
      const encoded = Buffer.from(leaf.relative, "utf8")
      const header = Buffer.alloc(4 + encoded.byteLength + 8)
      header.writeUInt32BE(encoded.byteLength); encoded.copy(header, 4); header.writeBigUInt64BE(BigInt(leaf.bytes.byteLength), 4 + encoded.byteLength)
      aggregate.update(header).update(hash).update(Buffer.from([Number(leaf.executable)]))
      return { ...leaf, hash }
    })
    const bytes = leaves.reduce((sum, leaf) => sum + leaf.bytes.byteLength, 0)
    if (bytes > LIMIT || leaves.some((leaf) => leaf.bytes.byteLength > MAX_BLOB || Buffer.byteLength(leaf.relative) > 2048 ||
      !leaf.relative || leaf.relative.includes("\\") || /[\u0000-\u001f\u007f:]/.test(leaf.relative) ||
      leaf.relative.split("/").some((name) => !name || name === "." || name === ".." || name.toLowerCase() === ".git" || name.startsWith(".dac-tree-")) ||
      leaf.relative.split("/").length > 32 || names.has(leaf.relative) || !names.add(leaf.relative))) return yield* failure(false)
    const manifest = aggregate.digest("hex")
    yield* asset.current.pipe(Effect.mapError(() => failure(false)))
    const state = { dispatched: false, closed: false, failed: false, sequence: 0, stdout: Buffer.alloc(0), stderr: 0,
      pending: undefined as undefined | { id: string; resolve: (value: typeof Reply.Type) => void; reject: (error: EventWorkDagSchema.Error) => void } }
    const child = yield* Effect.acquireRelease(start(asset).pipe(Effect.tap((child) => Effect.sync(() => {
      capacity.active++
      child.once("close", () => { state.closed = true; capacity.active--; state.pending?.reject(failure(state.dispatched)); state.pending = undefined })
    }))), (child) => Effect.promise(async () => {
      if (state.closed) return
      child.kill("SIGKILL")
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000)
        child.once("close", () => { clearTimeout(timer); resolve() })
      })
      // A lost exit ACK retains its active capacity until the actual close event.
    }))
    const stop = () => {
      if (state.failed) return
      state.failed = true
      state.pending?.reject(failure(state.dispatched)); state.pending = undefined
      if (!state.closed) child.kill("SIGKILL")
    }
    child.once("error", stop)
    child.stdin.on("error", stop)
    child.stderr.on("data", (data: Buffer) => { state.stderr += data.byteLength; if (state.stderr > 4096) stop() })
    child.stdout.on("data", (data: Buffer) => {
      if (state.failed || !state.pending || state.stdout.byteLength + data.byteLength > 65_540) { stop(); return }
      state.stdout = Buffer.concat([state.stdout, data])
      if (state.stdout.byteLength < 4) return
      const length = state.stdout.readUInt32BE()
      if (length < 1 || length > 65_536) { stop(); return }
      if (state.stdout.byteLength < 4 + length) return
      if (state.stdout.byteLength !== 4 + length) { stop(); return }
      const reply = Schema.decodeUnknownOption(Schema.fromJsonString(Reply), { onExcessProperty: "error" })(state.stdout.subarray(4).toString("utf8"))
      if (Option.isNone(reply) || reply.value.id !== state.pending.id || reply.value.code !== null || reply.value.status === "unknown") { stop(); return }
      const pending = state.pending; state.pending = undefined; state.stdout = Buffer.alloc(0); pending.resolve(reply.value)
    })
    const deadline = Math.min(input.expiresAt, Date.now() + MAX_TIME)
    const send = (body: Record<string, unknown>, status: string) => Effect.tryPromise({ try: (signal) => new Promise<typeof Reply.Type>((resolve, reject) => {
      if (state.failed || state.closed || state.pending || signal.aborted || Date.now() >= deadline) { reject(failure(state.dispatched)); return }
      const id = `tree-${state.sequence++}`
      const payload = Buffer.from(JSON.stringify({ version: 1, id, ...body }))
      if (payload.byteLength > 65_536) { reject(failure(state.dispatched)); return }
      const header = Buffer.alloc(4); header.writeUInt32BE(payload.byteLength)
      const timer = setTimeout(stop, Math.max(1, deadline - Date.now()))
      const clear = () => { clearTimeout(timer); signal.removeEventListener("abort", stop) }
      state.pending = { id, resolve: (reply) => {
        clear(); if (reply.status !== status || status !== "closed" && JSON.stringify(reply.root) !== JSON.stringify(input.identity)) { stop(); reject(failure(state.dispatched)); return }
        resolve(reply)
      }, reject: (error) => { clear(); reject(error) } }
      signal.addEventListener("abort", stop, { once: true })
      if (body.op === "event_tree_begin") state.dispatched = true
      child.stdin.write(Buffer.concat([header, payload]), (error) => { if (error) stop() })
    }), catch: () => failure(state.dispatched) })
    yield* send({ op: "open_root", path: input.directory, expected: input.identity }, "ready")
    yield* send({ op: "event_tree_begin", files: leaves.length, bytes, manifest_sha256: manifest, deadline_ms: deadline - Date.now() }, "tree_ready")
    for (const leaf of leaves) {
      yield* send({ op: "event_tree_leaf", relative: leaf.relative, bytes: leaf.bytes.byteLength, sha256: leaf.hash, executable: leaf.executable }, "tree_leaf")
      for (let offset = 0; offset < leaf.bytes.byteLength; offset += 16_384)
        yield* send({ op: "event_tree_chunk", offset, hex: leaf.bytes.subarray(offset, offset + 16_384).toString("hex") }, "tree_written")
      yield* send({ op: "event_tree_publish" }, "tree_published")
    }
    const reply = yield* send({ op: "event_tree_finish" }, "tree_completed")
    if (!reply.snapshot || reply.allocated_bytes === undefined || reply.snapshot.manifest_sha256 !== manifest || reply.snapshot.files !== leaves.length || reply.snapshot.bytes !== bytes ||
      JSON.stringify(reply.snapshot.workspace) !== JSON.stringify(input.identity)) return yield* failure(true)
    yield* asset.current.pipe(Effect.mapError(() => failure(true)))
    yield* send({ op: "close" }, "closed")
    return { files: leaves.length, bytes, manifestSha256: manifest, allocatedBytes: reply.allocated_bytes }
  })
  return { materialize, observe, headroom, objectAllocation, administrationAllocation, collect, supported, current: asset.current }
})

/** Private original-asset channel. It has no model-facing operation or caller executable.
 * Read operations cannot mutate; known collection has a separate dispatch fence.
 * Bounded close preserves active capacity until the actual exit. */
function lease(asset: Effect.Success<ReturnType<typeof treeAsset>>, deadline: number) {
  return Effect.gen(function* () {
    const state = { closed: false, failed: false, cleanupDispatched: false, cleanupRequestID: undefined as string | undefined,
      buffer: Buffer.alloc(0), sequence: 0,
      pending: undefined as { id: string; resolve: (reply: { reply: typeof ObservedReply.Type; bytes: Buffer }) => void;
        reject: (error: EventWorkDagSchema.Error) => void } | undefined }
    const child = yield* Effect.acquireRelease(start(asset).pipe(Effect.tap((child) => Effect.sync(() => {
      capacity.active++
      child.once("close", () => { state.closed = true; capacity.active--; state.pending?.reject(failure(state.cleanupDispatched)); state.pending = undefined })
    }))), (child) => Effect.promise(async () => {
      if (state.closed) return
      child.kill("SIGKILL")
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 1000); child.once("close", () => { clearTimeout(timer); resolve() }) })
    }))
    const stop = () => {
      state.failed = true; state.pending?.reject(failure(state.cleanupDispatched)); state.pending = undefined
      if (!state.closed) child.kill("SIGKILL")
    }
    child.once("error", stop); child.stdin.on("error", stop)
    const stderr = { bytes: 0 }
    child.stderr.on("data", (bytes: Buffer) => { stderr.bytes += bytes.byteLength; if (stderr.bytes > 4096) stop() })
    child.stdout.on("data", (bytes: Buffer) => {
      if (state.failed || !state.pending || state.buffer.byteLength + bytes.byteLength > 1_114_116) { stop(); return }
      state.buffer = Buffer.concat([state.buffer, bytes])
      if (state.buffer.byteLength < 4) return
      const length = state.buffer.readUInt32BE()
      if (length < 1 || length > 65_536) { stop(); return }
      if (state.buffer.byteLength < 4 + length) return
      const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(ObservedReply), { onExcessProperty: "error" })(state.buffer.subarray(4, 4 + length).toString())
      // Only the exact original Native before-mutation refusal can clear a
      // dispatched collection fence. A malformed/lost/unknown reply cannot.
      if (state.cleanupDispatched && Option.isSome(decoded) && decoded.value.id === state.pending.id &&
        decoded.value.id === state.cleanupRequestID && decoded.value.root === null && decoded.value.observation === null &&
        decoded.value.allocated_bytes === undefined && decoded.value.snapshot === undefined &&
        decoded.value.capture_id === undefined && decoded.value.binary_complete === undefined &&
        decoded.value.status === "refused" && decoded.value.code === "FILE_SCOPE_UNAVAILABLE" &&
        decoded.value.payload_bytes === 0 && state.buffer.byteLength === 4 + length) state.cleanupDispatched = false
      if (Option.isNone(decoded) || decoded.value.id !== state.pending.id || decoded.value.code !== null ||
        decoded.value.payload_bytes < 0 || decoded.value.payload_bytes > 1_048_576) { stop(); return }
      const needed = 4 + length + decoded.value.payload_bytes
      if (state.buffer.byteLength < needed) return
      if (state.buffer.byteLength !== needed) { stop(); return }
      const pending = state.pending; state.pending = undefined
      const payload = Buffer.from(state.buffer.subarray(4 + length)); state.buffer = Buffer.alloc(0)
      pending.resolve({ reply: decoded.value, bytes: payload })
    })
    const send = (body: Record<string, unknown>, status?: string) => Effect.tryPromise({ try: (signal) => new Promise<{ reply: typeof ObservedReply.Type; bytes: Buffer }>((resolve, reject) => {
      if (state.failed || state.closed || state.pending || signal.aborted || Date.now() >= deadline) { reject(failure(state.cleanupDispatched)); return }
      const id = `observe-${state.sequence++}`; const bytes = Buffer.from(JSON.stringify({ version: 1, id, ...body }))
      if (bytes.byteLength > 65_536) { reject(failure(state.cleanupDispatched)); return }
      const header = Buffer.alloc(4); header.writeUInt32BE(bytes.byteLength)
      const timer = setTimeout(stop, Math.max(1, deadline - Date.now()))
      const clear = () => { clearTimeout(timer); signal.removeEventListener("abort", stop) }
      state.pending = { id, resolve: (value) => { clear(); status && value.reply.status !== status ? reject(failure(state.cleanupDispatched)) : resolve(value) },
        reject: (error) => { clear(); reject(error) } }
      signal.addEventListener("abort", stop, { once: true })
      if (body.op === "event_tree_collect") { state.cleanupRequestID = id; state.cleanupDispatched = true }
      child.stdin.write(Buffer.concat([header, bytes]), (error) => { if (error) stop() })
    }), catch: () => failure(state.cleanupDispatched) })
    return { send }
  })
}

/** Windows uses the same original installed helper External. Its executable
 * description cannot be copied into a raw-spawn authority. Other validation and
 * browser callers keep their separate Windows gates until their own ports exist. */
function treeAsset(expectedHash: string) {
  return Effect.gen(function* () {
    if (process.platform !== "win32") {
      const value = yield* WorkFileHelper.validationAsset(expectedHash).pipe(Effect.mapError(() => failure(false)))
      return { ...value, current: value.current.pipe(Effect.mapError(() => failure(false))), native: undefined }
    }
    const { asset, launch } = yield* Effect.promise(() => import("./windows-work-file-helper"))
    const installation = yield* NativeInstallation.current().pipe(Effect.mapError(() => failure(false)))
    const value = yield* asset(installation).pipe(Effect.mapError(() => failure(false)))
    const factory = yield* Effect.serviceOption(NativeWindowsWorkFactory.Service)
    if (value.hash !== expectedHash || Option.isNone(factory)) return yield* failure(false)
    const current = NativeInstallation.requireCurrent(installation).pipe(Effect.mapError(() => failure(false)),
      Effect.andThen(factory.value.current.pipe(Effect.mapError(() => failure(false)))))
    return { filename: value.filename, current, native: launch(value).pipe(Effect.mapError(() => failure(false))) }
  })
}
function start(asset: Effect.Success<ReturnType<typeof treeAsset>>): Effect.Effect<TreeProcess, EventWorkDagSchema.Error, Scope.Scope> {
  return Effect.gen(function* () {
    if (capacity.active + capacity.opening >= 2) return yield* failure(false)
    capacity.opening++
    return yield* Effect.gen(function* () {
    yield* asset.current
    if (process.platform === "win32") {
      if (!asset.native) return yield* failure(false)
      return yield* asset.native
    }
    return yield* Effect.try({ try: () => spawn(asset.filename, [], {
      cwd: path.dirname(asset.filename), env: {}, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    }), catch: () => failure(false) })
    }).pipe(Effect.ensuring(Effect.sync(() => { capacity.opening-- })))
  })
}
