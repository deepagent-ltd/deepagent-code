import { Cause, Duration, Effect, Layer, Schedule, Schema, Semaphore, Context } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { formatPatch, structuredPatch } from "diff"
import path from "path"
import { AppProcess } from "@deepagent-code/core/process"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Hash } from "@deepagent-code/core/util/hash"
import { NonNegativeInt } from "@deepagent-code/core/schema"
import { Config } from "@/config/config"
import { Global } from "@deepagent-code/core/global"
import * as Log from "@deepagent-code/core/util/log"

export const Patch = Schema.Struct({
  hash: Schema.String,
  files: Schema.mutable(Schema.Array(Schema.String)),
})
export type Patch = typeof Patch.Type

export const FileDiff = Schema.Struct({
  // Optional because legacy/imported `summary_diffs` on disk may omit
  // file details and patch text. Required Schema rejected the whole
  // session response and broke session loading on Desktop.
  file: Schema.optional(Schema.String),
  patch: Schema.optional(Schema.String),
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.optional(Schema.Literals(["added", "deleted", "modified"])),
}).annotate({ identifier: "SnapshotFileDiff" })
export type FileDiff = typeof FileDiff.Type

export const DiffLimits = {
  candidateFiles: 1_000,
  captureCandidateFiles: 10_000,
  discoveryOutputBytes: 4 * 1024 * 1024,
  manifestBytes: 256 * 1024,
  captureFileBytes: 8 * 1024 * 1024,
  captureTotalBytes: 64 * 1024 * 1024,
  sourceFileBytes: 1 * 1024 * 1024,
  sourceTotalBytes: 16 * 1024 * 1024,
  patchFileBytes: 512 * 1024,
  patchTotalBytes: 4 * 1024 * 1024,
  fallbackFiles: 2,
  fallbackWallTime: Duration.seconds(1),
  wallTime: Duration.seconds(15),
} as const

export const DiffTruncationReason = Schema.Literals([
  "candidate_file_limit",
  "discovery_output_limit",
  "discovery_failed",
  "manifest_bytes_limit",
  "source_file_limit",
  "source_total_limit",
  "patch_file_limit",
  "patch_total_limit",
  "materialization_failed",
  "time_limit",
])
export type DiffTruncationReason = typeof DiffTruncationReason.Type

export const DiffManifest = Schema.Struct({
  files: Schema.Array(FileDiff),
  additions: Schema.Finite,
  deletions: Schema.Finite,
  totalFiles: NonNegativeInt,
  totalFilesExact: Schema.Boolean,
  statisticsExact: Schema.Boolean,
  includedFiles: NonNegativeInt,
  truncatedFiles: NonNegativeInt,
  manifestHash: Schema.String,
  completeness: Schema.Literals(["complete", "truncated"]),
  truncationReasons: Schema.Array(DiffTruncationReason),
})
export type DiffManifest = typeof DiffManifest.Type

const log = Log.create({ service: "snapshot" })
const prune = "7.days"
const limit = 2 * 1024 * 1024
const core = ["-c", "core.longpaths=true", "-c", "core.symlinks=true"]
const cfg = ["-c", "core.autocrlf=false", ...core]
const quote = [...cfg, "-c", "core.quotepath=false"]
interface GitResult {
  readonly code: ChildProcessSpawner.ExitCode
  readonly text: string
  readonly stderr: string
  readonly stdoutTruncated: boolean
  readonly timedOut: boolean
}

type DiffRow = {
  file: string
  status: "added" | "deleted" | "modified"
  binary: boolean
  additions: number
  deletions: number
}

type State = Omit<Interface, "init">

// BUG-407-012 gap C: optional session attribution threaded into capture budget
// warnings + the degraded outcome, so an over-budget snapshot can be attributed
// to the session/activity that triggered it.
export interface Attribution {
  readonly sessionId?: string
  readonly activityId?: string
}

export interface TrackOutcome {
  readonly hash?: string
  readonly degraded?: { readonly reason: string } & Record<string, unknown>
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly cleanup: () => Effect.Effect<void>
  readonly track: (attribution?: Attribution) => Effect.Effect<string | undefined>
  readonly trackOutcome: (attribution?: Attribution) => Effect.Effect<TrackOutcome>
  readonly patch: (hash: string) => Effect.Effect<Patch>
  readonly restore: (snapshot: string) => Effect.Effect<void>
  readonly revert: (patches: Patch[]) => Effect.Effect<void>
  readonly diff: (hash: string) => Effect.Effect<string>
  readonly diffManifest: (from: string, to: string) => Effect.Effect<DiffManifest>
  readonly diffFullManifest: (from: string, to: string) => Effect.Effect<DiffManifest>
  readonly diffFull: (from: string, to: string) => Effect.Effect<FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/Snapshot") {}

export const layer: Layer.Layer<Service, never, FSUtil.Service | AppProcess.Service | Config.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const appProcess = yield* AppProcess.Service
    const config = yield* Config.Service
    const locks = new Map<string, Semaphore.Semaphore>()

    const lock = (key: string) => {
      const hit = locks.get(key)
      if (hit) return hit

      const next = Semaphore.makeUnsafe(1)
      locks.set(key, next)
      return next
    }

    const state = yield* InstanceState.make<State>(
      Effect.fn("Snapshot.state")(function* (ctx) {
        const state = {
          directory: ctx.directory,
          worktree: ctx.worktree,
          gitdir: path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree)),
          vcs: ctx.project.vcs,
        }

        const args = (cmd: string[]) => ["--git-dir", state.gitdir, "--work-tree", state.worktree, ...cmd]

        const feed = (list: string[]) => list.join("\0") + "\0"

        const git = Effect.fnUntraced(
          function* (
            cmd: string[],
            opts?: {
              cwd?: string
              env?: Record<string, string>
              stdin?: string
              maxOutputBytes?: number
              maxErrorBytes?: number
              timeout?: Duration.Input
            },
          ) {
            const result = yield* appProcess.run(
              ChildProcess.make("git", cmd, { cwd: opts?.cwd, env: opts?.env, extendEnv: true }),
              {
                stdin: opts?.stdin,
                maxOutputBytes: opts?.maxOutputBytes,
                maxErrorBytes: opts?.maxErrorBytes ?? DiffLimits.discoveryOutputBytes,
                timeout: opts?.timeout,
              },
            )
            return {
              code: ChildProcessSpawner.ExitCode(result.exitCode),
              text: result.stdout.toString("utf8"),
              stderr: result.stderr.toString("utf8"),
              stdoutTruncated: result.stdoutTruncated,
              timedOut: false,
            } satisfies GitResult
          },
          Effect.catch((err) =>
            Effect.succeed({
              code: ChildProcessSpawner.ExitCode(1),
              text: "",
              stderr: err instanceof Error ? err.message : String(err),
              stdoutTruncated: false,
              timedOut: String(err).includes("Timed out"),
            }),
          ),
        )

        const ignore = Effect.fnUntraced(function* (files: string[], timeout = DiffLimits.wallTime) {
          if (!files.length) return { ok: true as const, files: new Set<string>() }
          const check = yield* git(
            [
              ...quote,
              "--git-dir",
              path.join(state.worktree, ".git"),
              "--work-tree",
              state.worktree,
              "check-ignore",
              "--no-index",
              "--stdin",
              "-z",
            ],
            {
              cwd: state.directory,
              stdin: feed(files),
              maxOutputBytes: DiffLimits.discoveryOutputBytes,
              timeout,
            },
          )
          if (
            (check.code !== 0 && check.code !== 1) ||
            check.stdoutTruncated ||
            check.timedOut
          )
            return { ok: false as const, timedOut: check.timedOut, outputLimited: check.stdoutTruncated }
          return { ok: true as const, files: new Set(check.text.split("\0").filter(Boolean)) }
        })

        const drop = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return true
          const result = yield* git(
            [
              ...cfg,
              ...args(["rm", "--cached", "-f", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"]),
            ],
            {
              cwd: state.directory,
              stdin: feed(files),
              maxOutputBytes: DiffLimits.discoveryOutputBytes,
              timeout: DiffLimits.wallTime,
            },
          )
          if (result.code === 0 && !result.stdoutTruncated && !result.timedOut) return true
          log.warn("failed to drop ignored snapshot files", { exitCode: result.code, stderr: result.stderr })
          return false
        })

        const stage = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return true
          const result = yield* git(
            [...cfg, ...args(["add", "--all", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"])],
            {
              cwd: state.directory,
              stdin: feed(files),
              maxOutputBytes: DiffLimits.discoveryOutputBytes,
              timeout: DiffLimits.wallTime,
            },
          )
          if (result.code === 0 && !result.stdoutTruncated && !result.timedOut) return true
          log.warn("failed to add snapshot files", {
            exitCode: result.code,
            stderr: result.stderr,
          })
          return false
        })

        const exists = (file: string) => fs.exists(file).pipe(Effect.orDie)
        const read = (file: string) => fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")))
        const remove = (file: string) => fs.remove(file).pipe(Effect.catch(() => Effect.void))
        const locked = <A, E, R>(fx: Effect.Effect<A, E, R>) => lock(state.gitdir).withPermits(1)(fx)

        const enabled = Effect.fnUntraced(function* () {
          if (state.vcs !== "git") return false
          return (yield* config.get()).snapshot !== false
        })

        const excludes = Effect.fnUntraced(function* () {
          const result = yield* git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], {
            cwd: state.worktree,
          })
          const file = result.text.trim()
          if (!file) return
          if (!(yield* exists(file))) return
          return file
        })

        const sync = Effect.fnUntraced(function* (list: string[] = []) {
          const file = yield* excludes()
          const target = path.join(state.gitdir, "info", "exclude")
          const text = [
            file ? (yield* read(file)).trimEnd() : "",
            ...list.map((item) => `/${item.replaceAll("\\", "/")}`),
          ]
            .filter(Boolean)
            .join("\n")
          yield* fs.ensureDir(path.join(state.gitdir, "info")).pipe(Effect.orDie)
          yield* fs.writeFileString(target, text ? `${text}\n` : "").pipe(Effect.orDie)
        })

        // BUG-407-012 gap C: budget failures return a typed degraded attribution
        // (reason + budget numbers) instead of a bare `false`, and budget warnings
        // carry the session/activity attribution of the triggering turn.
        const add = Effect.fnUntraced(function* (attribution?: Attribution) {
          yield* sync()
          const [diff, other] = yield* Effect.all(
            [
              git([...quote, ...args(["diff-files", "--name-only", "-z", "--", "."])], {
                cwd: state.directory,
                maxOutputBytes: DiffLimits.discoveryOutputBytes,
                timeout: DiffLimits.wallTime,
              }),
              git([...quote, ...args(["ls-files", "--others", "--exclude-standard", "-z", "--", "."])], {
                cwd: state.directory,
                maxOutputBytes: DiffLimits.discoveryOutputBytes,
                timeout: DiffLimits.wallTime,
              }),
            ],
            { concurrency: 2 },
          )
          if (
            diff.code !== 0 ||
            other.code !== 0 ||
            diff.stdoutTruncated ||
            other.stdoutTruncated ||
            diff.timedOut ||
            other.timedOut
          ) {
            log.warn("failed to list snapshot files", {
              diffCode: diff.code,
              diffStderr: diff.stderr,
              otherCode: other.code,
              otherStderr: other.stderr,
              ...attribution,
            })
            return { ok: false, degraded: { reason: "snapshot_discovery_failed", ...attribution } }
          }

          const tracked = diff.text.split("\0").filter(Boolean)
          const untracked = other.text.split("\0").filter(Boolean)
          const all = Array.from(new Set([...tracked, ...untracked]))
          if (!all.length) return { ok: true }
          if (all.length > DiffLimits.captureCandidateFiles) {
            log.warn("snapshot capture exceeded candidate budget", {
              files: all.length,
              limit: DiffLimits.captureCandidateFiles,
              ...attribution,
            })
            return {
              ok: false,
              degraded: {
                reason: "snapshot_candidate_budget_exceeded",
                files: all.length,
                limit: DiffLimits.captureCandidateFiles,
                ...attribution,
              },
            }
          }

          // Resolve source-repo ignore rules against the exact candidate set.
          // --no-index keeps this pattern-based even when a path is already tracked.
          const ignored = yield* ignore(all)
          if (!ignored.ok) {
            log.warn("failed to resolve snapshot ignore rules", {
              timedOut: ignored.timedOut,
              outputLimited: ignored.outputLimited,
              ...attribution,
            })
            return { ok: false, degraded: { reason: "snapshot_ignore_resolution_failed", ...attribution } }
          }

          // Remove newly-ignored files from snapshot index to prevent re-adding
          if (ignored.files.size > 0) {
            const ignoredFiles = Array.from(ignored.files)
            log.info("removing gitignored files from snapshot", { count: ignoredFiles.length })
            if (!(yield* drop(ignoredFiles)))
              return { ok: false, degraded: { reason: "snapshot_index_drop_failed", ...attribution } }
          }

          const allow = all.filter((item) => !ignored.files.has(item))
          if (!allow.length) return { ok: true }

          const sizes = (yield* Effect.all(
            allow.map((item) =>
              fs
                .stat(path.join(state.directory, item))
                .pipe(Effect.catch(() => Effect.void))
                .pipe(
                  Effect.map((stat) => {
                    if (!stat || stat.type !== "File") return
                    const size = typeof stat.size === "bigint" ? Number(stat.size) : stat.size
                    return { item, size }
                  }),
                ),
            ),
            { concurrency: 8 },
          )).filter((item): item is { item: string; size: number } => Boolean(item))
          const large = new Set(sizes.filter((item) => item.size > limit).map((item) => item.item))
          const block = new Set(untracked.filter((item) => large.has(item)))
          yield* sync(Array.from(block))
          const staged = allow.filter((item) => !block.has(item))
          const stagedSizes = sizes.filter((item) => !block.has(item.item))
          const oversized = stagedSizes.find((item) => item.size > DiffLimits.captureFileBytes)
          const totalBytes = stagedSizes.reduce((total, item) => total + item.size, 0)
          if (oversized || totalBytes > DiffLimits.captureTotalBytes) {
            log.warn("snapshot capture exceeded source budget", {
              files: staged.length,
              totalBytes,
              totalLimit: DiffLimits.captureTotalBytes,
              oversizedFile: oversized?.item,
              fileLimit: DiffLimits.captureFileBytes,
              ...attribution,
            })
            return {
              ok: false,
              degraded: {
                reason: "snapshot_source_budget_exceeded",
                files: staged.length,
                totalBytes,
                totalLimit: DiffLimits.captureTotalBytes,
                oversizedFile: oversized?.item,
                fileLimit: DiffLimits.captureFileBytes,
                ...attribution,
              },
            }
          }
          // Stage only the allowed candidate paths so snapshot updates stay scoped.
          return yield* stage(staged).pipe(
            Effect.map((ok) => (ok ? { ok: true } : { ok: false, degraded: { reason: "snapshot_stage_failed", ...attribution } })),
          )
        })

        const captureOutcome = (attribution?: Attribution): Effect.Effect<TrackOutcome> =>
          add(attribution).pipe(
            Effect.map((result) => (result.ok ? {} : { degraded: result.degraded })),
            Effect.timeoutOrElse({
              duration: DiffLimits.wallTime,
              orElse: () =>
                Effect.logWarning("snapshot capture exceeded wall-time budget", attribution ?? {}).pipe(
                  Effect.as({
                    degraded: {
                      reason: "snapshot_wall_time_budget_exceeded",
                      wallTimeMs: Duration.toMillis(DiffLimits.wallTime),
                      ...attribution,
                    },
                  }),
                ),
            }),
          )

        // Boolean shape for non-turn callers (patch/diff/revert).
        const capture = (attribution?: Attribution) =>
          captureOutcome(attribution).pipe(Effect.map((outcome) => !outcome.degraded))

        const cleanup = Effect.fnUntraced(function* () {
          return yield* locked(
            Effect.gen(function* () {
              if (!(yield* enabled())) return
              if (!(yield* exists(state.gitdir))) return
              const result = yield* git(args(["gc", `--prune=${prune}`]), { cwd: state.directory })
              if (result.code !== 0) {
                log.warn("cleanup failed", {
                  exitCode: result.code,
                  stderr: result.stderr,
                })
                return
              }
              log.info("cleanup", { prune })
            }),
          )
        })

        const trackOutcome = Effect.fnUntraced(function* (attribution?: Attribution) {
          return yield* locked(
            Effect.gen(function* () {
              if (!(yield* enabled())) return {}
              const existed = yield* exists(state.gitdir)
              yield* fs.ensureDir(state.gitdir).pipe(Effect.orDie)
              if (!existed) {
                yield* git(["init"], {
                  env: { GIT_DIR: state.gitdir, GIT_WORK_TREE: state.worktree },
                })
                yield* git(["--git-dir", state.gitdir, "config", "core.autocrlf", "false"])
                yield* git(["--git-dir", state.gitdir, "config", "core.longpaths", "true"])
                yield* git(["--git-dir", state.gitdir, "config", "core.symlinks", "true"])
                yield* git(["--git-dir", state.gitdir, "config", "core.fsmonitor", "false"])
                log.info("initialized")
              }
              const captured = yield* captureOutcome(attribution)
              if (captured.degraded) return captured
              const result = yield* git(args(["write-tree"]), { cwd: state.directory })
              if (result.code !== 0 || result.timedOut)
                return {
                  degraded: {
                    reason: "snapshot_write_tree_failed",
                    exitCode: result.code,
                    timedOut: result.timedOut,
                    ...attribution,
                  },
                }
              const hash = result.text.trim()
              log.info("tracking", { hash, cwd: state.directory, git: state.gitdir })
              return { hash }
            }),
          )
        })

        const track = Effect.fnUntraced(function* (attribution?: Attribution) {
          return (yield* trackOutcome(attribution)).hash
        })

        const patch = Effect.fnUntraced(function* (hash: string) {
          return yield* locked(
            Effect.gen(function* () {
              if (!(yield* capture())) return { hash, files: [] }
              const result = yield* git(
                [...quote, ...args(["diff", "--cached", "--no-ext-diff", "--name-only", hash, "--", "."])],
                {
                  cwd: state.directory,
                  maxOutputBytes: DiffLimits.discoveryOutputBytes,
                  timeout: DiffLimits.wallTime,
                },
              )
              if (result.code !== 0 || result.stdoutTruncated || result.timedOut) {
                log.warn("failed to get diff", { hash, exitCode: result.code })
                return { hash, files: [] }
              }
              const files = result.text
                .trim()
                .split("\n")
                .map((x) => x.trim())
                .filter(Boolean)

              // Hide ignored-file removals from the user-facing patch output.
              const ignored = yield* ignore(files)
              if (!ignored.ok) {
                log.warn("failed to resolve ignored patch files", {
                  timedOut: ignored.timedOut,
                  outputLimited: ignored.outputLimited,
                })
                return { hash, files: [] }
              }

              return {
                hash,
                files: files
                  .filter((item) => !ignored.files.has(item))
                  .map((x) => path.join(state.worktree, x).replaceAll("\\", "/")),
              }
            }),
          )
        })

        const restore = Effect.fnUntraced(function* (snapshot: string) {
          return yield* locked(
            Effect.gen(function* () {
              log.info("restore", { commit: snapshot })
              const result = yield* git([...core, ...args(["read-tree", snapshot])], { cwd: state.worktree })
              if (result.code === 0) {
                const checkout = yield* git([...core, ...args(["checkout-index", "-a", "-f"])], {
                  cwd: state.worktree,
                })
                if (checkout.code === 0) return
                log.error("failed to restore snapshot", {
                  snapshot,
                  exitCode: checkout.code,
                  stderr: checkout.stderr,
                })
                return
              }
              log.error("failed to restore snapshot", {
                snapshot,
                exitCode: result.code,
                stderr: result.stderr,
              })
            }),
          )
        })

        const revert = Effect.fnUntraced(function* (patches: Patch[]) {
          return yield* locked(
            Effect.gen(function* () {
              const ops: { hash: string; file: string; rel: string }[] = []
              const seen = new Set<string>()
              for (const item of patches) {
                for (const file of item.files) {
                  if (seen.has(file)) continue
                  seen.add(file)
                  ops.push({
                    hash: item.hash,
                    file,
                    rel: path.relative(state.worktree, file).replaceAll("\\", "/"),
                  })
                }
              }

              const single = Effect.fnUntraced(function* (op: (typeof ops)[number]) {
                log.info("reverting", { file: op.file, hash: op.hash })
                const result = yield* git([...core, ...args(["checkout", op.hash, "--", op.file])], {
                  cwd: state.worktree,
                })
                if (result.code === 0) return
                const tree = yield* git([...core, ...args(["ls-tree", op.hash, "--", op.rel])], {
                  cwd: state.worktree,
                })
                if (tree.code === 0 && tree.text.trim()) {
                  log.info("file existed in snapshot but checkout failed, keeping", { file: op.file, hash: op.hash })
                  return
                }
                log.info("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                yield* remove(op.file)
              })

              const clash = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)

              for (let i = 0; i < ops.length; ) {
                const first = ops[i]!
                const run = [first]
                let j = i + 1
                // Only batch adjacent files when their paths cannot affect each other.
                while (j < ops.length && run.length < 100) {
                  const next = ops[j]!
                  if (next.hash !== first.hash) break
                  if (run.some((item) => clash(item.rel, next.rel))) break
                  run.push(next)
                  j += 1
                }

                if (run.length === 1) {
                  yield* single(first)
                  i = j
                  continue
                }

                const tree = yield* git(
                  [...core, ...args(["ls-tree", "--name-only", first.hash, "--", ...run.map((item) => item.rel)])],
                  {
                    cwd: state.worktree,
                  },
                )

                if (tree.code !== 0) {
                  log.info("batched ls-tree failed, falling back to single-file revert", {
                    hash: first.hash,
                    files: run.length,
                  })
                  for (const op of run) {
                    yield* single(op)
                  }
                  i = j
                  continue
                }

                const have = new Set(
                  tree.text
                    .trim()
                    .split("\n")
                    .map((item) => item.trim())
                    .filter(Boolean),
                )
                const list = run.filter((item) => have.has(item.rel))
                if (list.length) {
                  log.info("reverting", { hash: first.hash, files: list.length })
                  const result = yield* git(
                    [...core, ...args(["checkout", first.hash, "--", ...list.map((item) => item.file)])],
                    {
                      cwd: state.worktree,
                    },
                  )
                  if (result.code !== 0) {
                    log.info("batched checkout failed, falling back to single-file revert", {
                      hash: first.hash,
                      files: list.length,
                    })
                    for (const op of run) {
                      yield* single(op)
                    }
                    i = j
                    continue
                  }
                }

                for (const op of run) {
                  if (have.has(op.rel)) continue
                  log.info("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                  yield* remove(op.file)
                }

                i = j
              }
            }),
          )
        })

        const diff = Effect.fnUntraced(function* (hash: string) {
          return yield* locked(
            Effect.gen(function* () {
              if (!(yield* capture())) return ""
              const result = yield* git([...quote, ...args(["diff", "--cached", "--no-ext-diff", hash, "--", "."])], {
                cwd: state.worktree,
                maxOutputBytes: DiffLimits.patchTotalBytes,
                timeout: DiffLimits.wallTime,
              })
              if (result.code !== 0 || result.stdoutTruncated || result.timedOut) {
                log.warn("failed to get diff", {
                  hash,
                  exitCode: result.code,
                  stderr: result.stderr,
                })
                return ""
              }
              return result.text.trim()
            }),
          )
        })

        const buildDiffManifest = Effect.fnUntraced(function* (from: string, to: string, deadline: number) {
              const reasons = new Set<DiffTruncationReason>()
              const status = new Map<string, "added" | "deleted" | "modified">()
              const remaining = () => Duration.millis(Math.max(1, deadline - Date.now()))

              const statuses = yield* git(
                [...quote, ...args(["diff", "--no-ext-diff", "--name-status", "--no-renames", from, to, "--", "."])],
                {
                  cwd: state.directory,
                  maxOutputBytes: DiffLimits.discoveryOutputBytes,
                  timeout: remaining(),
                },
              )
              if (statuses.code !== 0) reasons.add("discovery_failed")
              if (statuses.stdoutTruncated) {
                reasons.add("discovery_output_limit")
                log.warn("snapshot diff candidate discovery exceeded output budget", {
                  maxOutputBytes: DiffLimits.discoveryOutputBytes,
                })
              }
              if (statuses.timedOut) reasons.add("time_limit")

              for (const line of statuses.text.trim().split("\n")) {
                if (!line) continue
                const [code, file] = line.split("\t")
                if (!code || !file) continue
                status.set(file, code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified")
              }

              const numstat = yield* git(
                [...quote, ...args(["diff", "--no-ext-diff", "--no-renames", "--numstat", from, to, "--", "."])],
                {
                  cwd: state.directory,
                  maxOutputBytes: DiffLimits.discoveryOutputBytes,
                  timeout: remaining(),
                },
              )
              if (numstat.code !== 0) reasons.add("discovery_failed")
              if (numstat.stdoutTruncated) reasons.add("discovery_output_limit")
              if (numstat.timedOut) reasons.add("time_limit")

              const discovered = numstat.text
                .trim()
                .split("\n")
                .filter(Boolean)
                .flatMap((line) => {
                  const [adds, dels, file] = line.split("\t")
                  if (!file) return []
                  const binary = adds === "-" && dels === "-"
                  const additions = binary ? 0 : parseInt(adds)
                  const deletions = binary ? 0 : parseInt(dels)
                  return [
                    {
                      file,
                      status: status.get(file) ?? "modified",
                      binary,
                      additions: Number.isFinite(additions) ? additions : 0,
                      deletions: Number.isFinite(deletions) ? deletions : 0,
                    } satisfies DiffRow,
                  ]
                })
              // Hide ignored-file removals from the user-facing diff output.
              const ignored = yield* ignore(
                discovered.map((r) => r.file),
                remaining(),
              )
              if (!ignored.ok) {
                reasons.add(ignored.timedOut ? "time_limit" : "discovery_failed")
                if (ignored.outputLimited) reasons.add("discovery_output_limit")
              }
              const visibleDiscovered = ignored.ok
                ? discovered.filter((row) => !ignored.files.has(row.file))
                : discovered
              if (visibleDiscovered.length > DiffLimits.candidateFiles || numstat.stdoutTruncated)
                reasons.add("candidate_file_limit")
              const rows = visibleDiscovered.slice(0, DiffLimits.candidateFiles)

              const files: FileDiff[] = []
              let manifestBytes = 2
              for (const row of rows) {
                const item = {
                  file: row.file,
                  ...(row.binary ? { patch: "" } : {}),
                  additions: row.additions,
                  deletions: row.deletions,
                  status: row.status,
                } satisfies FileDiff
                const bytes = Buffer.byteLength(JSON.stringify(item)) + (files.length ? 1 : 0)
                if (manifestBytes + bytes > DiffLimits.manifestBytes) {
                  reasons.add("manifest_bytes_limit")
                  break
                }
                files.push(item)
                manifestBytes += bytes
              }

              const totalFilesExact: boolean =
                numstat.code === 0 && !numstat.stdoutTruncated && !numstat.timedOut && ignored.ok
              const totalFiles = totalFilesExact
                ? visibleDiscovered.length
                : Math.max(visibleDiscovered.length, files.length + 1)
              const manifest = {
                files,
                additions: files.reduce((sum, item) => sum + item.additions, 0),
                deletions: files.reduce((sum, item) => sum + item.deletions, 0),
                totalFiles,
                totalFilesExact,
                statisticsExact:
                  totalFilesExact && files.length === totalFiles && reasons.size === 0,
                includedFiles: files.length,
                truncatedFiles: Math.max(0, totalFiles - files.length),
                manifestHash: `sha256:${Hash.sha256(
                  JSON.stringify({
                    version: 1,
                    from,
                    to,
                    files,
                    totalFiles,
                    totalFilesExact,
                    reasons: [...reasons].sort(),
                  }),
                )}`,
                completeness:
                  reasons.size || files.length < totalFiles ? ("truncated" as const) : ("complete" as const),
                truncationReasons: [...reasons].sort(),
              } satisfies DiffManifest
              return manifest
        })

        const diffManifest = Effect.fnUntraced(function* (from: string, to: string) {
          const deadline = Date.now() + Duration.toMillis(DiffLimits.wallTime)
          return yield* locked(buildDiffManifest(from, to, deadline))
        })

        const materializeDiff = Effect.fnUntraced(function* (
          from: string,
          to: string,
          manifest: DiffManifest,
          deadline: number,
        ) {
          const remaining = () => Duration.millis(Math.max(1, deadline - Date.now()))
              const result: FileDiff[] = []
              const reasons = new Set(manifest.truncationReasons)
              const rows: DiffRow[] = manifest.files.map((item) => ({
                file: item.file ?? "",
                status: item.status ?? "modified",
                binary: item.patch === "",
                additions: item.additions,
                deletions: item.deletions,
              }))
              type Ref = { file: string; side: "before" | "after"; ref: string }
              const show = Effect.fnUntraced(function* (row: DiffRow) {
                if (row.binary) return ["", ""]
                const read = (ref: string) =>
                  git([...cfg, ...args(["show", ref])], {
                    cwd: state.directory,
                    maxOutputBytes: DiffLimits.sourceFileBytes,
                    timeout: Duration.millis(
                      Math.max(
                        1,
                        Math.min(Duration.toMillis(DiffLimits.fallbackWallTime), deadline - Date.now()),
                      ),
                    ),
                  })
                const accept = (result: GitResult) =>
                  result.code === 0 && !result.stdoutTruncated && !result.timedOut ? result.text : undefined
                if (row.status === "added") {
                  const after = accept(yield* read(`${to}:${row.file}`))
                  return after === undefined ? undefined : (["", after] as const)
                }
                if (row.status === "deleted") {
                  const before = accept(yield* read(`${from}:${row.file}`))
                  return before === undefined ? undefined : ([before, ""] as const)
                }
                const pair = yield* Effect.all([read(`${from}:${row.file}`), read(`${to}:${row.file}`)], {
                  concurrency: 2,
                })
                const before = accept(pair[0])
                const after = accept(pair[1])
                return before === undefined || after === undefined ? undefined : ([before, after] as const)
              })

              const load = Effect.fnUntraced(
                function* (rows: DiffRow[], remainingSourceBytes: number) {
                  const refs = rows.flatMap((row) => {
                    if (row.binary) return []
                    if (row.status === "added")
                      return [{ file: row.file, side: "after", ref: `${to}:${row.file}` } satisfies Ref]
                    if (row.status === "deleted")
                      return [{ file: row.file, side: "before", ref: `${from}:${row.file}` } satisfies Ref]
                    return [
                      { file: row.file, side: "before", ref: `${from}:${row.file}` } satisfies Ref,
                      { file: row.file, side: "after", ref: `${to}:${row.file}` } satisfies Ref,
                    ]
                  })
                  if (!refs.length) return new Map<string, { before: string; after: string }>()
                  const batch = yield* appProcess.run(
                    ChildProcess.make("git", [...cfg, ...args(["cat-file", "--batch"])], {
                      cwd: state.directory,
                      extendEnv: true,
                    }),
                    {
                      stdin: refs.map((item) => item.ref).join("\n") + "\n",
                      maxOutputBytes:
                        Math.max(1, Math.min(DiffLimits.sourceTotalBytes, remainingSourceBytes)) + refs.length * 128,
                      maxErrorBytes: DiffLimits.discoveryOutputBytes,
                      timeout: remaining(),
                    },
                  )
                  if (batch.exitCode !== 0 || batch.stdoutTruncated || batch.stderrTruncated) return
                  const map = new Map<string, { before: string; after: string }>()
                  const decoder = new TextDecoder()
                  let offset = 0
                  for (const ref of refs) {
                    let end = offset
                    while (end < batch.stdout.length && batch.stdout[end] !== 10) end += 1
                    if (end >= batch.stdout.length) return
                    const head = decoder.decode(batch.stdout.slice(offset, end))
                    offset = end + 1
                    const hit = map.get(ref.file) ?? { before: "", after: "" }
                    if (head.endsWith(" missing")) {
                      map.set(ref.file, hit)
                      continue
                    }
                    const match = head.match(/^[0-9a-f]+ blob (\d+)$/)
                    const size = Number(match?.[1])
                    if (!match || !Number.isInteger(size) || size < 0) return
                    if (size > DiffLimits.sourceFileBytes) {
                      reasons.add("source_file_limit")
                      return
                    }
                    if (offset + size >= batch.stdout.length || batch.stdout[offset + size] !== 10) return
                    const text = decoder.decode(batch.stdout.slice(offset, offset + size))
                    if (ref.side === "before") hit.before = text
                    if (ref.side === "after") hit.after = text
                    map.set(ref.file, hit)
                    offset += size + 1
                  }
                  return offset === batch.stdout.length ? map : undefined
                },
                Effect.scoped,
                Effect.catch(() =>
                  Effect.succeed<Map<string, { before: string; after: string }> | undefined>(undefined),
                ),
              )

              const step = 100
              let sourceBytes = 0
              let patchBytes = 0
              let fallbackFiles = 0
              const patch = (file: string, before: string, after: string) =>
                formatPatch(structuredPatch(file, file, before, after, "", "", { context: Number.MAX_SAFE_INTEGER }))

              for (let i = 0; i < rows.length; i += step) {
                const run = rows.slice(i, i + step)
                if (
                  Date.now() >= deadline ||
                  sourceBytes >= DiffLimits.sourceTotalBytes ||
                  patchBytes >= DiffLimits.patchTotalBytes
                ) {
                  if (Date.now() >= deadline) reasons.add("time_limit")
                  if (sourceBytes >= DiffLimits.sourceTotalBytes) reasons.add("source_total_limit")
                  if (patchBytes >= DiffLimits.patchTotalBytes) reasons.add("patch_total_limit")
                  result.push(...rows.slice(i).map(({ file, additions, deletions, status }) => ({ file, additions, deletions, status })))
                  break
                }
                const text = yield* load(run, DiffLimits.sourceTotalBytes - sourceBytes)

                for (const row of run) {
                  if (
                    Date.now() >= deadline ||
                    sourceBytes >= DiffLimits.sourceTotalBytes ||
                    patchBytes >= DiffLimits.patchTotalBytes
                  ) {
                    if (Date.now() >= deadline) reasons.add("time_limit")
                    if (sourceBytes >= DiffLimits.sourceTotalBytes) reasons.add("source_total_limit")
                    if (patchBytes >= DiffLimits.patchTotalBytes) reasons.add("patch_total_limit")
                    result.push(
                      ...run
                        .slice(run.indexOf(row))
                        .map(({ file, additions, deletions, status }) => ({ file, additions, deletions, status })),
                    )
                    break
                  }
                  if (text && !text.has(row.file) && !row.binary) {
                    reasons.add("materialization_failed")
                    result.push({
                      file: row.file,
                      patch: "",
                      additions: row.additions,
                      deletions: row.deletions,
                      status: row.status,
                    })
                    continue
                  }
                  const hit = text?.get(row.file)
                  const canFallback = !text && !row.binary && fallbackFiles < DiffLimits.fallbackFiles
                  if (canFallback) fallbackFiles += 1
                  const contents = row.binary
                    ? (["", ""] as const)
                    : hit
                      ? ([hit.before, hit.after] as const)
                      : canFallback
                        ? yield* show(row)
                        : undefined
                  if (!contents) {
                    reasons.add("materialization_failed")
                    result.push({
                      file: row.file,
                      patch: "",
                      additions: row.additions,
                      deletions: row.deletions,
                      status: row.status,
                    })
                    continue
                  }
                  const [before, after] = contents
                  const observedSourceBytes = Buffer.byteLength(before) + Buffer.byteLength(after)
                  if (
                    observedSourceBytes > DiffLimits.sourceFileBytes ||
                    sourceBytes + observedSourceBytes > DiffLimits.sourceTotalBytes
                  ) {
                    reasons.add(
                      observedSourceBytes > DiffLimits.sourceFileBytes ? "source_file_limit" : "source_total_limit",
                    )
                    result.push({
                      file: row.file,
                      patch: "",
                      additions: row.additions,
                      deletions: row.deletions,
                      status: row.status,
                    })
                    continue
                  }
                  sourceBytes += observedSourceBytes
                  const body = row.binary ? "" : patch(row.file, before, after)
                  const patchSize = Buffer.byteLength(body)
                  const bounded =
                    patchSize > DiffLimits.patchFileBytes || patchBytes + patchSize > DiffLimits.patchTotalBytes
                      ? ""
                      : body
                  if (patchSize > DiffLimits.patchFileBytes) reasons.add("patch_file_limit")
                  else if (patchBytes + patchSize > DiffLimits.patchTotalBytes) reasons.add("patch_total_limit")
                  patchBytes += Buffer.byteLength(bounded)
                  result.push({
                    file: row.file,
                    patch: bounded,
                    additions: row.additions,
                    deletions: row.deletions,
                    status: row.status,
                  })
                }
              }

              const truncationReasons = [...reasons].sort()
              return {
                ...manifest,
                files: result,
                statisticsExact: manifest.statisticsExact,
                completeness: truncationReasons.length > 0 ? ("truncated" as const) : manifest.completeness,
                truncationReasons,
              } satisfies DiffManifest
        })

        const diffFullManifest = Effect.fnUntraced(function* (from: string, to: string) {
          const deadline = Date.now() + Duration.toMillis(DiffLimits.wallTime)
          return yield* locked(
            Effect.gen(function* () {
              const manifest = yield* buildDiffManifest(from, to, deadline)
              if (Date.now() < deadline) return yield* materializeDiff(from, to, manifest, deadline)
              return {
                ...manifest,
                completeness: "truncated" as const,
                truncationReasons: [...new Set([...manifest.truncationReasons, "time_limit" as const])].sort(),
              }
            }),
          )
        })

        const diffFull = Effect.fnUntraced(function* (from: string, to: string) {
          return (yield* diffFullManifest(from, to)).files
        })

        yield* cleanup().pipe(
          Effect.catchCause((cause) => {
            log.error("cleanup loop failed", { cause: Cause.pretty(cause) })
            return Effect.void
          }),
          Effect.repeat(Schedule.spaced(Duration.hours(1))),
          Effect.delay(Duration.minutes(1)),
          Effect.forkScoped,
        )

        return { cleanup, track, trackOutcome, patch, restore, revert, diff, diffManifest, diffFullManifest, diffFull }
      }),
    )

    return Service.of({
      init: Effect.fn("Snapshot.init")(function* () {
        yield* InstanceState.get(state)
      }),
      cleanup: Effect.fn("Snapshot.cleanup")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.cleanup())
      }),
      track: Effect.fn("Snapshot.track")(function* (attribution?: Attribution) {
        return yield* InstanceState.useEffect(state, (s) => s.track(attribution))
      }),
      trackOutcome: Effect.fn("Snapshot.trackOutcome")(function* (attribution?: Attribution) {
        return yield* InstanceState.useEffect(state, (s) => s.trackOutcome(attribution))
      }),
      patch: Effect.fn("Snapshot.patch")(function* (hash: string) {
        return yield* InstanceState.useEffect(state, (s) => s.patch(hash))
      }),
      restore: Effect.fn("Snapshot.restore")(function* (snapshot: string) {
        return yield* InstanceState.useEffect(state, (s) => s.restore(snapshot))
      }),
      revert: Effect.fn("Snapshot.revert")(function* (patches: Patch[]) {
        return yield* InstanceState.useEffect(state, (s) => s.revert(patches))
      }),
      diff: Effect.fn("Snapshot.diff")(function* (hash: string) {
        return yield* InstanceState.useEffect(state, (s) => s.diff(hash))
      }),
      diffManifest: Effect.fn("Snapshot.diffManifest")(function* (from: string, to: string) {
        return yield* InstanceState.useEffect(state, (s) => s.diffManifest(from, to))
      }),
      diffFullManifest: Effect.fn("Snapshot.diffFullManifest")(function* (from: string, to: string) {
        return yield* InstanceState.useEffect(state, (s) => s.diffFullManifest(from, to))
      }),
      diffFull: Effect.fn("Snapshot.diffFull")(function* (from: string, to: string) {
        return yield* InstanceState.useEffect(state, (s) => s.diffFull(from, to))
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(AppProcess.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Config.defaultLayer),
)

export * as Snapshot from "."
