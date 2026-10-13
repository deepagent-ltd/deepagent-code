import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { Effect, Option, Schema } from "effect"
import { Global } from "@deepagent-code/core/global"
import { EventWorkTree } from "../../src/installation/event-work-tree"
import { NativeWindowsWorkFactory } from "../../src/installation/windows-work-factory"
import { WindowsWorkCommandRuntime } from "../../src/installation/windows-work-command-runtime"
import { WorkFileHelper } from "../../src/installation/work-file-helper"
import { NativeInstallation } from "../../src/installation/native-installation"
import { asset, launch } from "../../src/installation/windows-work-file-helper"

/** Native filesystem module fixture only. The caller supplies the original
 * preloaded Root context. This does not construct a Work, Git registration or
 * an Event authority, and cannot substitute for the full three-node run. */
export const run = (project: string) => Effect.gen(function* () {
  const stage = (value: string) => Effect.sync(() => console.error(`WINDOWS_EVENT_FS_PHASE ${value}`))
  yield* stage("factory")
  const factory = yield* NativeWindowsWorkFactory.Service
  const runtime = yield* WindowsWorkCommandRuntime.make()
  yield* stage("tree_asset")
  const tree = yield* EventWorkTree.make(factory.description.helper.sha256)
  const source = path.join(project, "source")
  const binary = Buffer.from([0, 255, 128, 13, 10, 0, 2])
  yield* Effect.promise(async () => {
    await fs.mkdir(path.join(source, "src"), { recursive: true })
    await fs.writeFile(path.join(source, "src", "dirty.txt"), "uncommitted source\n", { flag: "wx" })
    await fs.writeFile(path.join(source, "src", "untracked.bin"), binary, { flag: "wx" })
    await fs.writeFile(path.join(source, ".env"), "private fixture only\n", { flag: "wx" })
  })
  yield* stage("source_inspect")
  const sourceRoot = yield* WorkFileHelper.inspectRoot(source)
  if (sourceRoot.rootIdentity.kind !== "windows") throw new Error("WINDOWS_EVENT_FIXTURE_ROOT_REQUIRED")
  const identity = { kind: "windows" as const, volume_serial: sourceRoot.rootIdentity.volumeSerial, file_id: sourceRoot.rootIdentity.fileID }
  yield* stage("baseline_observe")
  const observed = yield* tree.observe({ directory: source, identity, paths: [], expiresAt: Date.now() + 60_000,
    baselineScope: { read: [{ kind: "tree", path: "src" }], write: [], deny: [{ kind: "file", path: ".env" }],
      maxReadBytes: 16_777_216, maxPageBytes: 51_200, symlinks: "deny", maxWriteBytes: 16_777_216, maxHashBytes: 16_777_216 } }).pipe(Effect.scoped)
  if (observed.leaves.length !== 2 || !observed.leaves.find((leaf) => leaf.relative === "src/untracked.bin")?.bytes.equals(binary))
    throw new Error("WINDOWS_EVENT_BASELINE_CONTENT_MISMATCH")
  yield* stage("hardlink_refusal")
  yield* Effect.promise(() => fs.link(path.join(source, "src", "dirty.txt"), path.join(source, "alias.txt")))
  const aliasRefused = yield* tree.observe({ directory: source, identity, paths: [], expiresAt: Date.now() + 60_000,
    baselineScope: { read: [{ kind: "tree", path: "src" }], write: [], deny: [], maxReadBytes: 16_777_216,
      maxWriteBytes: 16_777_216, maxPageBytes: 51_200, symlinks: "deny", maxHashBytes: 16_777_216 } }).pipe(Effect.scoped, Effect.match({ onFailure: () => true, onSuccess: () => false }))
  if (!aliasRefused) throw new Error("WINDOWS_EVENT_HARDLINK_ACCEPTED")
  yield* Effect.promise(() => fs.unlink(path.join(source, "alias.txt")))
  yield* stage("workspace_create")
  const workspace = yield* runtime.createWorkspace(`cmd_${randomBytes(16).toString("hex")}`, source)
  const targetIdentity = { kind: "windows" as const, volume_serial: workspace.identity.volumeSerial, file_id: workspace.identity.fileID }
  yield* Effect.promise(() => fs.writeFile(path.join(workspace.directory, ".git"), "gitdir: fixture-registration\n", { flag: "wx" }))
  yield* stage("headroom")
  yield* tree.headroom({ directory: workspace.directory, identity: targetIdentity, reservationBytes: 536_870_912 })
  yield* stage("tree_materialize")
  const materialized = yield* tree.materialize({ directory: workspace.directory, identity: targetIdentity,
    leaves: observed.leaves, expiresAt: Date.now() + 60_000 }).pipe(Effect.scoped)
  yield* stage("target_observe")
  const target = yield* tree.observe({ directory: workspace.directory, identity: targetIdentity,
    paths: observed.leaves.map((leaf) => leaf.relative), expiresAt: Date.now() + 60_000 }).pipe(Effect.scoped)
  if (target.manifestSha256 !== observed.manifestSha256 || materialized.manifestSha256 !== observed.manifestSha256)
    throw new Error("WINDOWS_EVENT_TREE_MANIFEST_MISMATCH")
  yield* stage("wrong_manifest_collect")
  const refused = yield* tree.collect({ directory: workspace.directory, identity: targetIdentity,
    files: materialized.files, bytes: materialized.bytes, manifestSha256: "0".repeat(64) })
    .pipe(Effect.match({ onFailure: () => true, onSuccess: () => false }))
  if (!refused) throw new Error("WINDOWS_EVENT_WRONG_MANIFEST_ACCEPTED")
  yield* stage("known_collect")
  yield* tree.collect({ directory: workspace.directory, identity: targetIdentity, files: materialized.files,
    bytes: materialized.bytes, manifestSha256: materialized.manifestSha256 })
  const remainder = yield* Effect.promise(() => fs.readdir(workspace.directory))
  if (remainder.length !== 1 || remainder[0] !== ".git") throw new Error("WINDOWS_EVENT_KNOWN_GC_NOT_EXACT")
  yield* runtime.closeWorkspace(workspace)
  yield* factory.current
  return { scope: "windows-event-native-filesystem-module", pass: true, baselineFiles: 2, binaryBytes: binary.length,
    scopedSecretExcluded: true, hardlinkRefused: aliasRefused, wrongManifestRefused: refused,
    materializedBytes: materialized.bytes, nativeAllocatedBytes: materialized.allocatedBytes,
    knownContentCollected: true, registrationPreserved: true, realGitRegistration: false,
    fullEventAcceptance: false, providerCalls: 0, workAuthority: false, dataRootOriginal: Boolean(yield* Global.Service) }
})

/** Diagnostic projection from the original Root's helper pipe. These frames do
 * not construct an Event witness, change the parser, or authorize publication. */
export const probe = (project: string) => Effect.gen(function* () {
  const factory = yield* NativeWindowsWorkFactory.Service
  const source = path.join(project, "source")
  yield* Effect.promise(async () => {
    await fs.mkdir(path.join(source, "src"), { recursive: true })
    await fs.writeFile(path.join(source, "src", "dirty.txt"), "uncommitted source\n", { flag: "wx" })
    await fs.writeFile(path.join(source, "src", "untracked.bin"), Buffer.from([0, 255, 128, 13, 10, 0, 2]), { flag: "wx" })
    await fs.writeFile(path.join(source, ".env"), "private fixture only\n", { flag: "wx" })
  })
  const inspected = yield* WorkFileHelper.inspectRoot(source)
  if (inspected.rootIdentity.kind !== "windows") throw new Error("WINDOWS_EVENT_FIXTURE_ROOT_REQUIRED")
  const identity = { kind: "windows", volume_serial: inspected.rootIdentity.volumeSerial, file_id: inspected.rootIdentity.fileID }
  const child = yield* launch(yield* asset(yield* NativeInstallation.current()))
  const reply = Schema.Struct({ version: Schema.Literal(1), id: Schema.String, status: Schema.String,
    code: Schema.NullOr(Schema.String), root: Schema.Unknown, payload_bytes: Schema.Literal(0) })
  const state = { buffer: Buffer.alloc(0), pending: undefined as undefined | { id: string; resolve: (value: typeof reply.Type) => void; reject: () => void } }
  const diagnostics: string[] = []
  child.stderr.on("data", (bytes: Buffer) => {
    for (const line of bytes.toString("utf8").split(/\r?\n/))
      if (/^DAC_EVENT_(?:NATIVE_PHASE [a-z_]+|WINDOWS_FS_PHASE [a-z_-]+) [A-Za-z]+ -?\d+$/.test(line) && diagnostics.length < 8) diagnostics.push(line)
  })
  child.stdout.on("data", (bytes: Buffer) => {
    if (!state.pending || state.buffer.length + bytes.length > 65_540) { state.pending?.reject(); return }
    state.buffer = Buffer.concat([state.buffer, bytes])
    if (state.buffer.length < 4) return
    const length = state.buffer.readUInt32BE()
    if (length < 1 || length > 65_536) { state.pending.reject(); return }
    if (state.buffer.length < length + 4) return
    const value = Schema.decodeUnknownOption(Schema.fromJsonString(reply))(state.buffer.subarray(4, length + 4).toString("utf8"))
    if (Option.isNone(value) || value.value.id !== state.pending.id || state.buffer.length !== length + 4) { state.pending.reject(); return }
    const pending = state.pending; state.pending = undefined; state.buffer = Buffer.alloc(0)
    pending.resolve(value.value)
  })
  const send = (id: string, body: Record<string, unknown>) => Effect.tryPromise({ try: () => new Promise<typeof reply.Type>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WINDOWS_EVENT_PROBE_DEADLINE")), 10_000)
    state.pending = { id, resolve: (value) => { clearTimeout(timer); resolve(value) },
      reject: () => { clearTimeout(timer); reject(new Error("WINDOWS_EVENT_PROBE_FRAME")) } }
    const bytes = Buffer.from(JSON.stringify({ version: 1, id, ...body })); const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length)
    child.stdin.write(Buffer.concat([header, bytes]), (error) => { if (error) state.pending?.reject() })
  }), catch: () => new Error("WINDOWS_EVENT_PROBE_REFUSED") })
  const opened = yield* send("probe-open", { op: "open_root", path: source, expected: identity })
  const baseline = yield* send("probe-baseline", { op: "event_baseline_begin", read: [{ kind: "tree", path: "src" }],
    deny: [{ kind: "file", path: ".env" }], deadline_ms: 60_000 })
  const closed = yield* send("probe-close", { op: "close" })
  return { pass: true, diagnosticOnly: true, fullEventAcceptance: false, providerCalls: 0, workAuthority: false,
    transcript: [opened, baseline, closed].map((value) => ({ id: value.id, status: value.status, code: value.code,
      rootMatches: JSON.stringify(value.root) === JSON.stringify(identity) })), diagnostics }
}).pipe(Effect.scoped)
