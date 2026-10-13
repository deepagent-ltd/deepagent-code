export * as EventWorkGit from "./event-work-git"

import path from "node:path"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import { constants } from "node:fs"
import { createHash } from "node:crypto"
import { Context, Effect } from "effect"
import { EventWorkDagSchema } from "@deepagent-code/core/deepagent/event-work-dag.schema"
import type { EventWorkPlacement } from "@deepagent-code/core/deepagent/event-work-placement"
import { resolveDataPath } from "@deepagent-code/core/global-path"

const MAX_OUTPUT = 1_048_576
const TIMEOUT = 30_000
const failure = (code: EventWorkDagSchema.Error["code"]) => new EventWorkDagSchema.Error({ code,
  message: "Original bounded raw Git operation is unavailable, changed or has an unknown physical outcome" })
const commands = new Set(["rev-parse", "show-ref", "worktree", "merge-base", "ls-tree", "cat-file", "read-tree",
  "hash-object", "update-index", "write-tree", "commit-tree", "update-ref", "diff-tree", "rev-list"])
const mutations = new Set(["read-tree", "hash-object", "update-index", "write-tree", "commit-tree", "update-ref"])
const capturedWindows = new WeakMap<object, () => boolean>()
/** A pure ownership fence for an original Windows runtime returned by capture. */
export const isCurrent = (runtime: object) => capturedWindows.get(runtime)?.() === true

type Repository = { readonly directory: string; readonly gitDirectory: string; readonly current: Effect.Effect<void, EventWorkDagSchema.Error> }
export const Current = Context.Reference<{ readonly filename: string; readonly hash: string; readonly repository: Repository | undefined;
  readonly current: Effect.Effect<void, EventWorkDagSchema.Error>; readonly windows?: object } | undefined>("@deepagent-code/EventWorkGit/Current", { defaultValue: () => undefined })
const PrivateIndex = Context.Reference<{ filename: string; current: Effect.Effect<void, EventWorkDagSchema.Error> } | undefined>(
  "@deepagent-code/EventWorkGit/PrivateIndex", { defaultValue: () => undefined })
export const indexAllocation = Effect.gen(function* () {
  if (process.platform === "win32") {
    const { WindowsEventGit } = yield* Effect.promise(() => import("./windows-event-git"))
    return yield* WindowsEventGit.indexAllocation
  }
  const index = yield* PrivateIndex
  if (!index) return yield* failure("EVENT_DAG_UNAVAILABLE")
  yield* index.current
  const file = yield* Effect.acquireRelease(Effect.tryPromise({ try: () => fs.open(index.filename, constants.O_RDONLY | constants.O_NOFOLLOW),
    catch: () => failure("EVENT_DAG_UNAVAILABLE") }), (file) => Effect.promise(() => file.close()))
  const metadata = yield* Effect.tryPromise({ try: () => file.stat({ bigint: true }), catch: () => failure("EVENT_DAG_UNAVAILABLE") })
  if (!metadata.isFile() || metadata.nlink !== 1n || metadata.blocks * 512n > 16_777_216n) return yield* failure("EVENT_DAG_CAPACITY")
  yield* index.current
  return Number(metadata.blocks * 512n)
}).pipe(Effect.scoped)

/** Raw baseline construction owns a separate index. No index path can arrive from Work JSON,
 * a model argument or the caller's environment, and the original parent index is untouched. */
export const withPrivateIndex = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.gen(function* () {
  if (process.platform === "win32") {
    const original = yield* Current
    if (!original?.windows) return yield* failure("EVENT_DAG_UNAVAILABLE")
    const { WindowsEventGit } = yield* Effect.promise(() => import("./windows-event-git"))
    return yield* WindowsEventGit.withPrivateIndex(original.windows, effect)
  }
  const retained = { identity: undefined as { dev: bigint; ino: bigint } | undefined }
  const directory = yield* Effect.acquireRelease(Effect.tryPromise({ try: async () => {
    const root = path.join(resolveDataPath(), "tmp")
    await fs.mkdir(root, { recursive: true, mode: 0o700 })
    return fs.mkdtemp(path.join(await fs.realpath(root), "dac-event-index-"))
  },
    catch: () => failure("EVENT_DAG_UNAVAILABLE") }), (directory) => Effect.promise(async () => {
      const named = await fs.lstat(directory, { bigint: true }).catch(() => undefined)
      if (retained.identity && named?.isDirectory() && named.dev === retained.identity.dev && named.ino === retained.identity.ino)
        await fs.rm(directory, { recursive: true, force: true })
    }))
  const handle = yield* Effect.acquireRelease(Effect.tryPromise({ try: () => fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
    catch: () => failure("EVENT_DAG_UNAVAILABLE") }), (handle) => Effect.promise(() => handle.close()))
  const identity = yield* Effect.tryPromise({ try: () => handle.stat({ bigint: true }), catch: () => failure("EVENT_DAG_UNAVAILABLE") })
  retained.identity = identity
  const current = Effect.tryPromise({ try: async () => {
    const held = await handle.stat({ bigint: true }); const named = await fs.lstat(directory, { bigint: true })
    if (!held.isDirectory() || held.dev !== identity.dev || held.ino !== identity.ino || named.dev !== held.dev || named.ino !== held.ino ||
      (held.mode & 0o077n) !== 0n) throw failure("EVENT_DAG_UNAVAILABLE")
    const index = await fs.lstat(path.join(directory, "index"), { bigint: true }).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error))
    if (index && (!index.isFile() || index.nlink !== 1n || (index.mode & 0o022n) !== 0n)) throw failure("EVENT_DAG_UNAVAILABLE")
  }, catch: () => failure("EVENT_DAG_UNAVAILABLE") })
  yield* current
  return yield* effect.pipe(Effect.provideService(PrivateIndex, { filename: path.join(directory, "index"), current }))
}).pipe(Effect.scoped)

/** Retain one real executable, then recheck its name and bytes before the fixed argv path.
 * A later PATH mutation cannot select another Git process inside the captured factory. */
export const capture = Effect.gen(function* () {
  if (process.platform === "win32") {
    const { WindowsEventGit } = yield* Effect.promise(() => import("./windows-event-git"))
    const runtime = yield* WindowsEventGit.capture
    capturedWindows.set(runtime, () => WindowsEventGit.isCurrent(runtime.windows))
    yield* Effect.addFinalizer(() => Effect.sync(() => capturedWindows.delete(runtime)))
    return runtime
  }
  const filename = yield* Effect.tryPromise({ try: async () => {
    const choices = (process.env.PATH ?? "").split(path.delimiter).filter(path.isAbsolute)
      .map((directory) => path.join(directory, process.platform === "win32" ? "git.exe" : "git"))
    for (const value of choices) if (await fs.access(value, constants.X_OK).then(() => true, () => false)) return fs.realpath(value)
    throw failure("EVENT_DAG_UNAVAILABLE")
  }, catch: () => failure("EVENT_DAG_UNAVAILABLE") })
  const file = yield* Effect.acquireRelease(Effect.tryPromise({ try: () => fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
    catch: () => failure("EVENT_DAG_UNAVAILABLE") }), (file) => Effect.promise(() => file.close()))
  const observe = () => Effect.tryPromise({ try: async () => {
    const before = await file.stat({ bigint: true })
    if (!before.isFile() || before.size < 1n || before.size > 134_217_728n || before.nlink < 1n || (before.mode & 0o022n) !== 0n) throw failure("EVENT_DAG_UNAVAILABLE")
    const hash = createHash("sha256"); const buffer = Buffer.alloc(65_536); const total = { bytes: 0 }
    while (total.bytes < Number(before.size)) {
      const result = await file.read(buffer, 0, Math.min(buffer.byteLength, Number(before.size) - total.bytes), total.bytes)
      if (result.bytesRead === 0) throw failure("EVENT_DAG_UNAVAILABLE")
      total.bytes += result.bytesRead; hash.update(buffer.subarray(0, result.bytesRead))
    }
    const after = await file.stat({ bigint: true }); const named = await fs.lstat(filename, { bigint: true })
    const stamp = (value: typeof before) => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs, value.mode].join(":")
    if (stamp(before) !== stamp(after) || stamp(after) !== stamp(named) || await fs.realpath(filename) !== filename) throw failure("EVENT_DAG_UNAVAILABLE")
    return { hash: hash.digest("hex"), stamp: stamp(after) }
  }, catch: () => failure("EVENT_DAG_UNAVAILABLE") })
  const value = yield* observe()
  return { filename, hash: value.hash, repository: undefined as Repository | undefined, windows: undefined as object | undefined, current: Effect.tryPromise({ try: async () => {
    const held = await file.stat({ bigint: true }); const named = await fs.lstat(filename, { bigint: true })
    const stamp = (metadata: typeof held) => [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs, metadata.mode].join(":")
    if (stamp(held) !== value.stamp || stamp(named) !== value.stamp || await fs.realpath(filename) !== filename) throw failure("EVENT_DAG_UNAVAILABLE")
  }, catch: () => failure("EVENT_DAG_UNAVAILABLE") }) }
})
export const prepareParent = (repositoryRoot: string, parent: string) => Effect.gen(function* () {
  const original = yield* Current
  if (process.platform !== "win32" || !original?.windows) return yield* failure("EVENT_DAG_UNAVAILABLE")
  const { WindowsEventGit } = yield* Effect.promise(() => import("./windows-event-git"))
  return yield* WindowsEventGit.prepareParent(original.windows, repositoryRoot, parent)
})

/** The original factory pins the repository metadata before mutations. Git never follows a
 * later child .git pointer, caller environment, or replacement of the parent marker. */
export const pinRepository = (directory: string, runtime: Effect.Success<typeof capture>) => Effect.gen(function* () {
  if (process.platform === "win32") {
    if (!runtime.windows) return yield* failure("EVENT_DAG_UNAVAILABLE")
    const { WindowsEventGit } = yield* Effect.promise(() => import("./windows-event-git"))
    return yield* WindowsEventGit.pinRepository(directory, { ...runtime, windows: runtime.windows })
  }
  const observed = yield* run({ directory, args: ["rev-parse", "--path-format=absolute", "--git-common-dir"] })
    .pipe(Effect.provideService(Current, runtime))
  const common = observed.stdout.toString().trim()
  if (observed.exitCode !== 0 || !path.isAbsolute(common) || /[\u0000-\u001f\u007f]/.test(common)) return yield* failure("EVENT_DAG_UNAVAILABLE")
  const marker = yield* Effect.acquireRelease(Effect.tryPromise({ try: () => fs.open(path.join(directory, ".git"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
    catch: () => failure("EVENT_DAG_UNAVAILABLE") }), (file) => Effect.promise(() => file.close()))
  const metadata = yield* Effect.tryPromise({ try: () => marker.stat({ bigint: true }), catch: () => failure("EVENT_DAG_UNAVAILABLE") })
  if (!metadata.isDirectory() && (!metadata.isFile() || metadata.nlink !== 1n || metadata.size > 8192n)) return yield* failure("EVENT_DAG_UNAVAILABLE")
  const file = yield* Effect.acquireRelease(Effect.tryPromise({ try: () => fs.open(common, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
    catch: () => failure("EVENT_DAG_UNAVAILABLE") }), (file) => Effect.promise(() => file.close()))
  const identity = yield* Effect.tryPromise({ try: () => file.stat({ bigint: true }), catch: () => failure("EVENT_DAG_UNAVAILABLE") })
  const markerStamp = [metadata.dev, metadata.ino, metadata.mode, ...(metadata.isFile() ? [metadata.size, metadata.mtimeNs, metadata.ctimeNs] : [])].join(":")
  const current = Effect.tryPromise({ try: async () => {
    const held = await file.stat({ bigint: true }); const named = await fs.lstat(common, { bigint: true })
    const current = await marker.stat({ bigint: true }); const currentNamed = await fs.lstat(path.join(directory, ".git"), { bigint: true })
    const stamp = (value: typeof metadata) => [value.dev, value.ino, value.mode, ...(value.isFile() ? [value.size, value.mtimeNs, value.ctimeNs] : [])].join(":")
    if (!held.isDirectory() || held.dev !== identity.dev || held.ino !== identity.ino || held.dev !== named.dev || held.ino !== named.ino ||
      stamp(current) !== markerStamp || stamp(currentNamed) !== markerStamp || await fs.realpath(common) !== common) throw failure("EVENT_DAG_UNAVAILABLE")
  }, catch: () => failure("EVENT_DAG_UNAVAILABLE") })
  yield* current
  return { ...runtime, repository: { directory, gitDirectory: common, current } }
})

/** Private physical producer, never a model tool or grant. Checkout, add and commit porcelain
 * are deliberately absent: they can invoke repository filters or hooks before an authority
 * consumer gets to inspect the result. Files and the index are populated from raw objects. */
export const run = Effect.fn("EventWorkGit.run")(function* (input: {
  readonly directory: string
  readonly args: readonly string[]
  readonly stdin?: Buffer
  readonly blob?: boolean
  readonly commitTime?: number
}) {
  if (!path.isAbsolute(input.directory) || !input.args.length || !commands.has(input.args[0]!) || input.args.length > 64 ||
    input.args.some((arg) => /[\u0000-\u001f\u007f]/.test(arg)) || input.args.reduce((bytes, arg) => bytes + Buffer.byteLength(arg), 0) > 8192 ||
    (input.stdin?.byteLength ?? 0) > 16_777_216 || input.blob && input.args[0] !== "cat-file" ||
    !valid(input.args) ||
    input.commitTime !== undefined && (!Number.isSafeInteger(input.commitTime) || input.commitTime < 1))
    return yield* failure("EVENT_DAG_INVALID")
  if (process.platform === "win32") {
    const original = yield* Current
    if (!original?.windows) return yield* failure("EVENT_DAG_UNAVAILABLE")
    const { WindowsEventGit } = yield* Effect.promise(() => import("./windows-event-git"))
    return yield* WindowsEventGit.run(original.windows, input)
  }
  const creating = input.args[0] === "worktree" && input.args[1] === "add"
  if (input.args[0] === "worktree" && input.args[1] !== "list" && !creating)
    return yield* failure("EVENT_DAG_INVALID")
  const mutating = creating || mutations.has(input.args[0]!)
  const args = creating ? [...input.args.slice(0, 2), "--no-checkout", ...input.args.slice(2)] : input.args
  const nullFile = "/dev/null"
  const environment = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL"]
    .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]))
  const runtime = yield* Current
  if (runtime) yield* runtime.current
  if (runtime?.repository) {
    if (input.directory !== runtime.repository.directory) return yield* failure("EVENT_DAG_UNAVAILABLE")
    yield* runtime.repository.current
  }
  const index = yield* PrivateIndex
  if (index) yield* index.current
  return yield* Effect.callback<{ exitCode: number; stdout: Buffer; stderr: Buffer }, EventWorkDagSchema.Error>((resume, signal) => {
    const child = spawn(runtime?.filename ?? "git", ["-c", `core.hooksPath=${nullFile}`, "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false",
      "-c", "commit.gpgSign=false", "-c", "gc.auto=0", "-c", "core.pager=cat", "-c", `core.attributesFile=${nullFile}`, ...args], {
      cwd: input.directory, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: { ...environment, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: nullFile, GIT_CONFIG_GLOBAL: nullFile,
        GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "", GIT_OPTIONAL_LOCKS: "0", GIT_ATTR_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1",
        ...(runtime?.repository ? { GIT_DIR: runtime.repository.gitDirectory, GIT_WORK_TREE: runtime.repository.directory } : {}),
        GIT_AUTHOR_NAME: "DeepAgent Code", GIT_AUTHOR_EMAIL: "agent@deepagent.code", GIT_COMMITTER_NAME: "DeepAgent Code",
        GIT_COMMITTER_EMAIL: "agent@deepagent.code", ...(index ? { GIT_INDEX_FILE: index.filename } : {}), ...(input.commitTime ? {
          GIT_AUTHOR_DATE: `@${Math.floor(input.commitTime / 1000)} +0000`, GIT_COMMITTER_DATE: `@${Math.floor(input.commitTime / 1000)} +0000`,
        } : {}) },
    })
    const state = { stdout: [] as Buffer[], stderr: [] as Buffer[], stdoutBytes: 0, stderrBytes: 0, failed: false, closed: false }
    const fail = () => {
      if (state.closed || state.failed) return
      state.failed = true
      child.kill("SIGKILL")
    }
    const timer = setTimeout(fail, TIMEOUT)
    const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
      if (state.failed || state.closed) return
      const bytes = stream === "stdout" ? "stdoutBytes" : "stderrBytes"
      state[bytes] += chunk.byteLength
      if (state[bytes] > (stream === "stdout" && input.blob ? 16_777_216 : stream === "stdout" && input.args[0] === "rev-list" ? 2_097_152 : MAX_OUTPUT)) { fail(); return }
      state[stream].push(Buffer.from(chunk))
    }
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk))
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk))
    child.stdin.on("error", fail)
    child.once("error", fail)
    child.once("close", (code) => {
      state.closed = true
      clearTimeout(timer)
      signal.removeEventListener("abort", fail)
      if (state.failed || code === null) {
        resume(Effect.fail(failure(mutating ? "EVENT_DAG_UNKNOWN" : "EVENT_DAG_UNAVAILABLE")))
        return
      }
      resume(Effect.gen(function* () {
        if (runtime) yield* runtime.current
        if (runtime?.repository) yield* runtime.repository.current
        if (index) yield* index.current
        return { exitCode: code, stdout: Buffer.concat(state.stdout), stderr: Buffer.concat(state.stderr) }
      }).pipe(Effect.mapError(() => failure(mutating ? "EVENT_DAG_UNKNOWN" : "EVENT_DAG_UNAVAILABLE"))))
    })
    signal.addEventListener("abort", fail, { once: true })
    if (signal.aborted) fail()
    child.stdin.end(input.stdin)
    // Interruption waits for this owned child's real exit. No process, output buffer or
    // filesystem result is abandoned and subsequently treated as a known no-effect.
    return Effect.callback<void>((finish) => {
      fail()
      if (state.closed) { finish(Effect.void); return }
      child.once("close", () => finish(Effect.void))
    })
  })
})


/** No command variant can request a filter, textconv, pager, submodule, network
 * operation or repository-defined merge driver. Node instructions never reach argv. */
function valid(args: readonly string[]) {
  const oid = (value: string | undefined) => value !== undefined && /^[a-f0-9]{40,64}$/.test(value)
  const branch = (value: string | undefined) => value !== undefined && /^deepagent-code\/event-[a-f0-9]{24}$/.test(value)
  const ref = (value: string | undefined) => value !== undefined && /^refs\/heads\/deepagent-code\/event-[a-f0-9]{24}$/.test(value)
  if (args[0] === "cat-file") return args.length === 3 && ["blob", "-s", "-t"].includes(args[1]!) && oid(args[2])
  if (args[0] === "ls-tree") return args.length === 4 && args[1] === "-rz" && args[2] === "--full-tree" && oid(args[3])
  if (args[0] === "hash-object") return args.length === 3 && args[1] === "-w" && args[2] === "--stdin"
  if (args[0] === "read-tree") return args.length === 2 && (oid(args[1]) || args[1] === "--empty")
  if (args[0] === "update-index") return args.length === 3 && args[1] === "-z" && args[2] === "--index-info"
  if (args[0] === "write-tree") return args.length === 1
  if (args[0] === "commit-tree") return args.length === 6 && oid(args[1]) && args[2] === "-p" && oid(args[3]) && args[4] === "-m" && args[5] === "DeepAgent Code event node artifact"
  if (args[0] === "update-ref") return args.length === 4 && ref(args[1]) && oid(args[2]) && oid(args[3])
  if (args[0] === "merge-base") return args.length === 4 && args[1] === "--is-ancestor" && oid(args[2]) && oid(args[3])
  if (args[0] === "show-ref") return args.length === 4 && args[1] === "--verify" && args[2] === "--quiet" && ref(args[3])
  if (args[0] === "rev-parse") return args.length === 2 && ["--show-toplevel", "--show-object-format", "HEAD"].includes(args[1]!) ||
    args.length === 3 && args[1] === "--path-format=absolute" && ["--git-common-dir", "--git-dir"].includes(args[2]!) ||
    args.length === 2 && ref(args[1]) || args.length === 3 && args[1] === "--verify" &&
    (args[2] === "HEAD^{commit}" || oid(args[2]?.replace(/\^\{commit\}$/, "")))
  if (args[0] === "diff-tree") return args.length === 5 && args[1] === "--no-commit-id" && args[2] === "--name-only" && args[3] === "-rz" && oid(args[4])
  if (args[0] === "rev-list") return args.length === 4 && args[1] === "--objects" && args[2] === "--no-object-names" &&
    /^[a-f0-9]{40,64}\.\.[a-f0-9]{40,64}$/.test(args[3]!)
  if (args[0] !== "worktree") return false
  if (args.length === 3 && args[1] === "list" && args[2] === "--porcelain") return true
  if (args[1] !== "add") return false
  return args.length === 4 && path.isAbsolute(args[2]!) && branch(args[3]) ||
    args.length === 6 && args[2] === "-b" && branch(args[3]) && path.isAbsolute(args[4]!) && oid(args[5])
}

/** Held Windows directory observations carry no Git or Work execution grant. */
export const retain = (directory: string, identity: EventWorkPlacement.Description["parentRootIdentity"]) => Effect.gen(function* () {
  if (process.platform !== "win32") return yield* failure("EVENT_DAG_UNAVAILABLE")
  const { WindowsEventGit } = yield* Effect.promise(() => import("./windows-event-git"))
  return yield* WindowsEventGit.retain(directory, identity)
})
