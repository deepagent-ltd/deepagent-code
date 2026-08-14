import { Duration, Effect, Layer, Context, Schema, Stream, Scope } from "effect"
import { formatPatch, structuredPatch } from "diff"
import { InstanceState } from "@/effect/instance-state"
import { Watcher } from "@deepagent-code/core/filesystem/watcher"
import { Git } from "@/git"
import * as Log from "@deepagent-code/core/util/log"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@deepagent-code/core/event"

const log = Log.create({ service: "vcs" })
const PATCH_CONTEXT_LINES = 2_147_483_647
const MAX_PATCH_BYTES = 10_000_000
const MAX_TOTAL_PATCH_BYTES = 10_000_000
export const RawDiffLimits = {
  candidateFiles: 1_000,
  discoveryBytes: 4 * 1024 * 1024,
  wallTimeMs: 15_000,
  patchBytes: 10 * 1024 * 1024,
} as const
type DiffOptions = {
  readonly context?: number
}

const emptyPatch = (file: string) => formatPatch(structuredPatch(file, file, "", "", "", "", { context: 0 }))

const nums = (list: Git.Stat[]) =>
  new Map(list.map((item) => [item.file, { additions: item.additions, deletions: item.deletions }] as const))

const merge = (...lists: Git.Item[][]) => {
  const out = new Map<string, Git.Item>()
  lists.flat().forEach((item) => {
    if (!out.has(item.file)) out.set(item.file, item)
  })
  return [...out.values()]
}

const emptyBatch = () => ({ patches: new Map<string, string>(), capped: false })

const parseQuotedPath = (value: string) => {
  let out = ""
  for (let idx = 1; idx < value.length; idx++) {
    const char = value[idx]
    if (char === '"') return { value: out, end: idx + 1 }
    if (char !== "\\") {
      out += char
      continue
    }

    const next = value[++idx]
    if (next === "t") out += "\t"
    else if (next === "n") out += "\n"
    else if (next === "r") out += "\r"
    else if (next === '"' || next === "\\") out += next
    else out += next ?? ""
  }
}

const parsePathToken = (value: string) => {
  if (!value.startsWith('"')) return value.split("\t")[0]
  return parseQuotedPath(value)?.value ?? value
}

const fileFromDiffPath = (value: string | undefined) => {
  if (!value || value === "/dev/null") return
  const file = parsePathToken(value)
  if (file.startsWith("a/") || file.startsWith("b/")) return file.slice(2)
  return file
}

const fileFromGitHeader = (header: string) => {
  if (header.startsWith('"')) {
    const first = parseQuotedPath(header)
    const second = first ? header.slice(first.end).trimStart() : undefined
    if (!second) return
    if (!second.startsWith('"')) return fileFromDiffPath(second)
    return fileFromDiffPath(parseQuotedPath(second)?.value)
  }

  const separator = header.indexOf(" b/")
  if (separator === -1) return
  return fileFromDiffPath(header.slice(separator + 1))
}

const fileFromPatchChunk = (chunk: string) => {
  const next = /^\+\+\+ (.+)$/m.exec(chunk)?.[1]
  const before = /^--- (.+)$/m.exec(chunk)?.[1]
  const file = fileFromDiffPath(next) ?? fileFromDiffPath(before)
  if (file) return file

  const header = /^diff --git (.+)$/m.exec(chunk)?.[1]
  return fileFromGitHeader(header ?? "")
}

const splitGitPatch = (patch: Git.Patch) => {
  const starts = [...patch.text.matchAll(/(?:^|\n)diff --git /g)].map((match) =>
    match[0].startsWith("\n") ? match.index + 1 : match.index,
  )
  const chunks = starts.map((start, index) => patch.text.slice(start, starts[index + 1] ?? patch.text.length))
  if (!patch.truncated) return chunks
  return chunks.slice(0, -1)
}

const batchPatches = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string,
  list: Git.Item[],
  options?: DiffOptions,
) {
  if (list.length === 0) return { patches: new Map<string, string>(), capped: false }

  const result = yield* git.patchAll(cwd, ref, {
    context: options?.context ?? PATCH_CONTEXT_LINES,
    maxOutputBytes: MAX_TOTAL_PATCH_BYTES,
  })
  if (result.truncated) log.warn("batched patch exceeded byte limit", { max: MAX_TOTAL_PATCH_BYTES })

  return {
    patches: splitGitPatch(result).reduce((acc, patch, index) => {
      const file = fileFromPatchChunk(patch) ?? list[index]?.file
      if (!file) return acc
      acc.set(file, (acc.get(file) ?? "") + patch)
      return acc
    }, new Map<string, string>()),
    capped: result.truncated,
  }
})

const nativePatch = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  item: Git.Item,
  options?: DiffOptions,
) {
  const result =
    item.code === "??" || !ref
      ? yield* git.patchUntracked(cwd, item.file, {
          context: options?.context ?? PATCH_CONTEXT_LINES,
          maxOutputBytes: MAX_PATCH_BYTES,
        })
      : yield* git.patch(cwd, ref, item.file, {
          context: options?.context ?? PATCH_CONTEXT_LINES,
          maxOutputBytes: MAX_PATCH_BYTES,
        })
  if (!result.truncated && result.text) return result.text

  if (result.truncated) log.warn("patch exceeded byte limit", { file: item.file, max: MAX_PATCH_BYTES })
  return emptyPatch(item.file)
})

const totalPatch = (file: string, patch: string, total: number) => {
  if (total + Buffer.byteLength(patch) <= MAX_TOTAL_PATCH_BYTES) return { patch, capped: false }
  log.warn("total patch budget exceeded", { file, max: MAX_TOTAL_PATCH_BYTES })
  return { patch: emptyPatch(file), capped: true }
}

const patchForItem = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  item: Git.Item,
  batch: { patches: Map<string, string>; capped: boolean },
  capped: boolean,
  options?: DiffOptions,
) {
  if (capped) return emptyPatch(item.file)

  const batched = batch.patches.get(item.file)
  if (batched !== undefined) return batched
  if (item.code !== "??" && batch.capped) return emptyPatch(item.file)
  return yield* nativePatch(git, cwd, ref, item, options)
})

const files = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  list: Git.Item[],
  map: Map<string, { additions: number; deletions: number }>,
  batch: { patches: Map<string, string>; capped: boolean },
  options?: DiffOptions,
) {
  const next: FileDiff[] = []
  let total = 0
  let capped = false

  for (const item of list.toSorted((a, b) => a.file.localeCompare(b.file))) {
    const stat = map.get(item.file) ?? (item.status === "added" ? yield* git.statUntracked(cwd, item.file) : undefined)
    const patch = yield* patchForItem(git, cwd, ref, item, batch, capped, options)
    const result: { patch: string; capped: boolean } = capped
      ? { patch, capped: true }
      : totalPatch(item.file, patch, total)
    capped = capped || result.capped
    if (!capped) {
      total += Buffer.byteLength(result.patch)
      capped = total >= MAX_TOTAL_PATCH_BYTES
    }
    next.push({
      file: item.file,
      patch: result.patch,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
      status: item.status,
    })
  }

  return next
})

const diffAgainstRef = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string,
  options?: DiffOptions,
) {
  const [list, stats, extra] = yield* Effect.all([git.diff(cwd, ref), git.stats(cwd, ref), git.status(cwd)], {
    concurrency: 3,
  })
  return yield* files(
    git,
    cwd,
    ref,
    merge(
      list,
      extra.filter((item) => item.code === "??"),
    ),
    nums(stats),
    yield* batchPatches(git, cwd, ref, list, options),
    options,
  )
})

const track = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  options?: DiffOptions,
) {
  if (!ref) return yield* files(git, cwd, ref, yield* git.status(cwd), new Map(), emptyBatch(), options)
  return yield* diffAgainstRef(git, cwd, ref, options)
})

export const Mode = Schema.Literals(["git", "branch"])
export type Mode = Schema.Schema.Type<typeof Mode>

export const Event = {
  BranchUpdated: EventV2.define({
    type: "vcs.branch.updated",
    schema: {
      branch: Schema.optional(Schema.String),
    },
  }),
}

export const Info = Schema.Struct({
  branch: Schema.optional(Schema.String),
  default_branch: Schema.optional(Schema.String),
}).annotate({ identifier: "VcsInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export const FileDiff = Schema.Struct({
  file: Schema.String,
  // Mirrors Snapshot.FileDiff (see #26574). The current producer always
  // populates patch, but loosening matches the sibling schema so a
  // future code path that omits it can't crash /instance/vcs/diff.
  patch: Schema.optional(Schema.String),
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.optional(Schema.Literals(["added", "deleted", "modified"])),
}).annotate({ identifier: "VcsFileDiff" })
export type FileDiff = Schema.Schema.Type<typeof FileDiff>

export const FileStatus = Schema.Struct({
  file: Schema.String,
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.Literals(["added", "deleted", "modified"]),
}).annotate({ identifier: "VcsFileStatus" })
export type FileStatus = Schema.Schema.Type<typeof FileStatus>

export const ApplyInput = Schema.Struct({
  patch: Schema.String,
})
export type ApplyInput = Schema.Schema.Type<typeof ApplyInput>

export const ApplyResult = Schema.Struct({
  applied: Schema.Boolean,
})
export type ApplyResult = Schema.Schema.Type<typeof ApplyResult>

export class PatchApplyError extends Schema.TaggedErrorClass<PatchApplyError>()("VcsPatchApplyError", {
  message: Schema.String,
  reason: Schema.Literals(["non-git", "not-clean"]),
}) {}

export class RawDiffError extends Schema.TaggedErrorClass<RawDiffError>()("VcsRawDiffError", {
  message: Schema.String,
  reason: Schema.Literals([
    "candidate-files",
    "status-output",
    "status-failed",
    "tracked-output",
    "tracked-failed",
    "untracked-output",
    "untracked-failed",
    "total-output",
    "time-limit",
    "remote-status",
    "remote-output",
    "remote-decode",
  ]),
  limit: Schema.optional(Schema.Number),
  actual: Schema.optional(Schema.Number),
  file: Schema.optional(Schema.String),
}) {}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly branch: () => Effect.Effect<string | undefined>
  readonly defaultBranch: () => Effect.Effect<string | undefined>
  readonly status: () => Effect.Effect<FileStatus[]>
  readonly diff: (mode: Mode, options?: DiffOptions) => Effect.Effect<FileDiff[]>
  readonly diffRaw: () => Effect.Effect<string, RawDiffError>
  readonly apply: (input: ApplyInput) => Effect.Effect<ApplyResult, PatchApplyError>
}

interface State {
  current: string | undefined
  root: Git.Base | undefined
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/Vcs") {}

export const layer: Layer.Layer<Service, never, Git.Service | EventV2Bridge.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const git = yield* Git.Service
    const events = yield* EventV2Bridge.Service
    const scope = yield* Scope.Scope

    const state = yield* InstanceState.make<State>(
      Effect.fn("Vcs.state")(function* (ctx) {
        if (ctx.project.vcs !== "git") {
          return { current: undefined, root: undefined }
        }

        const get = Effect.fnUntraced(function* () {
          return yield* git.branch(ctx.directory)
        })
        const [current, root] = yield* Effect.all([git.branch(ctx.directory), git.defaultBranch(ctx.directory)], {
          concurrency: 2,
        })
        const value = { current, root }
        log.info("initialized", { branch: value.current, default_branch: value.root?.name })

        const unsubscribe = yield* events.listen((event) => {
          if (event.type !== Watcher.Event.Updated.type || event.location?.directory !== ctx.directory)
            return Effect.void
          const data = event.data as EventV2.Data<typeof Watcher.Event.Updated>
          if (!data.file.endsWith("HEAD")) return Effect.void
          return Effect.gen(function* () {
            const next = yield* get()
            if (next !== value.current) {
              log.info("branch changed", { from: value.current, to: next })
              value.current = next
              yield* events.publish(Event.BranchUpdated, { branch: next })
            }
          })
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        return value
      }),
    )

    return Service.of({
      init: Effect.fn("Vcs.init")(function* () {
        yield* InstanceState.get(state).pipe(Effect.forkIn(scope))
      }),
      branch: Effect.fn("Vcs.branch")(function* () {
        return yield* InstanceState.use(state, (x) => x.current)
      }),
      defaultBranch: Effect.fn("Vcs.defaultBranch")(function* () {
        return yield* InstanceState.use(state, (x) => x.root?.name)
      }),
      status: Effect.fn("Vcs.status")(function* () {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return []
        const ref = (yield* git.hasHead(ctx.directory)) ? "HEAD" : undefined
        const [list, stats] = yield* Effect.all(
          [git.status(ctx.directory), ref ? git.stats(ctx.directory, ref) : Effect.succeed([])],
          { concurrency: 2 },
        )
        const map = nums(stats)
        return yield* Effect.forEach(
          list.toSorted((a, b) => a.file.localeCompare(b.file)),
          (item) =>
            Effect.gen(function* () {
              const stat =
                map.get(item.file) ??
                (item.status === "added" ? yield* git.statUntracked(ctx.worktree, item.file) : undefined)
              return {
                file: item.file,
                additions: stat?.additions ?? 0,
                deletions: stat?.deletions ?? 0,
                status: item.status,
              } satisfies FileStatus
            }),
        )
      }),
      diff: Effect.fn("Vcs.diff")(function* (mode: Mode, options?: DiffOptions) {
        const value = yield* InstanceState.get(state)
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return []
        if (mode === "git") {
          return yield* track(git, ctx.directory, (yield* git.hasHead(ctx.directory)) ? "HEAD" : undefined, options)
        }

        if (!value.root) return []
        if (value.current && value.current === value.root.name) return []
        const ref = yield* git.mergeBase(ctx.directory, value.root.ref)
        if (!ref) return []
        return yield* diffAgainstRef(git, ctx.directory, ref, options)
      }),
      diffRaw: Effect.fn("Vcs.diffRaw")(function* () {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return ""
        const deadline = Date.now() + RawDiffLimits.wallTimeMs
        const deadlineRemaining = () => Duration.millis(Math.max(1, deadline - Date.now()))
        const [hasHead, status] = yield* Effect.all(
          [
            git
              .run(["rev-parse", "--verify", "HEAD"], {
                cwd: ctx.directory,
                maxErrorBytes: RawDiffLimits.discoveryBytes,
                maxOutputBytes: RawDiffLimits.discoveryBytes,
                timeout: deadlineRemaining(),
              })
              .pipe(Effect.map((result) => result.exitCode === 0)),
            git.run(["status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z", "--", "."], {
              cwd: ctx.directory,
              maxErrorBytes: RawDiffLimits.discoveryBytes,
              maxOutputBytes: RawDiffLimits.discoveryBytes,
              timeout: deadlineRemaining(),
            }),
          ],
          { concurrency: 2 },
        )
        if (Date.now() >= deadline)
          return yield* new RawDiffError({ message: "Raw diff discovery exceeded its deadline", reason: "time-limit" })
        if (status.truncated)
          return yield* new RawDiffError({
            message: "Raw diff status discovery exceeded its output budget",
            reason: "status-output",
            limit: RawDiffLimits.discoveryBytes,
          })
        if (status.exitCode !== 0)
          return yield* new RawDiffError({
            message: "Raw diff status discovery failed",
            reason: "status-failed",
          })

        const candidates = status
          .text()
          .split("\0")
          .filter(Boolean)
          .flatMap((item) => {
            const file = item.slice(3)
            if (!file) return []
            return [{ code: item.slice(0, 2), file }]
          })
        if (candidates.length > RawDiffLimits.candidateFiles)
          return yield* new RawDiffError({
            message: "Raw diff candidate file count exceeded its limit",
            reason: "candidate-files",
            limit: RawDiffLimits.candidateFiles,
            actual: candidates.length,
          })

        const patches: string[] = []
        let bytes = 0
        if (hasHead) {
          const tracked = yield* git.run(
            ["diff", "--patch", "--no-ext-diff", "--no-renames", "--unified=3", "HEAD", "--", "."],
            {
              cwd: ctx.directory,
              maxErrorBytes: RawDiffLimits.discoveryBytes,
              maxOutputBytes: RawDiffLimits.patchBytes + 1,
              timeout: deadlineRemaining(),
            },
          )
          if (Date.now() >= deadline)
            return yield* new RawDiffError({ message: "Tracked raw diff exceeded its deadline", reason: "time-limit" })
          if (tracked.truncated || tracked.stdout.byteLength > RawDiffLimits.patchBytes)
            return yield* new RawDiffError({
              message: "Tracked raw patch exceeded the total output budget",
              reason: "tracked-output",
              limit: RawDiffLimits.patchBytes,
            })
          if (tracked.exitCode !== 0)
            return yield* new RawDiffError({
              message: "Tracked raw patch generation failed",
              reason: "tracked-failed",
            })
          if (tracked.stdout.byteLength > 0) {
            patches.push(tracked.text())
            bytes = tracked.stdout.byteLength
          }
        }

        for (const item of candidates.filter((item) => item.code === "??" || (!hasHead && item.code[1] !== "D"))) {
          if (Date.now() >= deadline)
            return yield* new RawDiffError({ message: "Raw diff exceeded its deadline", reason: "time-limit" })
          const separator = patches.length > 0 ? 1 : 0
          const patchRemaining = RawDiffLimits.patchBytes - bytes - separator
          if (patchRemaining <= 0)
            return yield* new RawDiffError({
              message: "Raw patch exceeded the total output budget before all untracked files were encoded",
              reason: "total-output",
              limit: RawDiffLimits.patchBytes,
              actual: bytes + separator,
              file: item.file,
            })
          const patch = yield* git.run(
            [
              "diff",
              "--no-index",
              "--patch",
              "--no-ext-diff",
              "--no-renames",
              "--unified=3",
              "--",
              "/dev/null",
              item.file,
            ],
            {
              cwd: ctx.directory,
              maxErrorBytes: RawDiffLimits.discoveryBytes,
              maxOutputBytes: patchRemaining + 1,
              timeout: deadlineRemaining(),
            },
          )
          if (Date.now() >= deadline)
            return yield* new RawDiffError({ message: "Untracked raw diff exceeded its deadline", reason: "time-limit" })
          if (patch.truncated || patch.stdout.byteLength > patchRemaining)
            return yield* new RawDiffError({
              message: `Untracked raw patch exceeded the remaining output budget: ${item.file}`,
              reason: "untracked-output",
              limit: patchRemaining,
              file: item.file,
            })
          if (patch.exitCode !== 0 && patch.exitCode !== 1)
            return yield* new RawDiffError({
              message: `Untracked raw patch generation failed: ${item.file}`,
              reason: "untracked-failed",
              file: item.file,
            })
          if (patch.stdout.byteLength === 0) continue
          patches.push(patch.text())
          bytes += separator + patch.stdout.byteLength
        }
        const result = patches.join("\n")
        const actual = Buffer.byteLength(result)
        if (actual <= RawDiffLimits.patchBytes) return result
        return yield* new RawDiffError({
          message: "Raw patch exceeded the total UTF-8 output budget",
          reason: "total-output",
          limit: RawDiffLimits.patchBytes,
          actual,
        })
      }),
      apply: Effect.fn("Vcs.apply")(function* (input: ApplyInput) {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") {
          return yield* new PatchApplyError({
            message: "Patch can't be applied because the project is not git-based",
            reason: "non-git",
          })
        }
        const applied = yield* git.applyPatch(ctx.directory, input.patch)
        if (applied.exitCode !== 0) {
          return yield* new PatchApplyError({
            message: "Patch can't be applied",
            reason: "not-clean",
          })
        }
        return { applied: true }
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Git.defaultLayer), Layer.provide(EventV2Bridge.defaultLayer))

export * as Vcs from "./vcs"
