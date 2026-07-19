import { AppProcess } from "@deepagent-code/core/process"
import { Effect, Layer, Context, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"

const cfg = [
  "--no-optional-locks",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.longpaths=true",
  "-c",
  "core.symlinks=true",
  "-c",
  "core.quotepath=false",
] as const

const out = (result: { text(): string }) => result.text().trim()
const nuls = (text: string) => text.split("\0").filter(Boolean)
const fail = (err: unknown) =>
  ({
    exitCode: 1,
    text: () => "",
    stdout: Buffer.alloc(0),
    stderr: Buffer.from(err instanceof Error ? err.message : String(err)),
    truncated: false,
  }) satisfies Result

export type Kind = "added" | "deleted" | "modified"

export type Base = {
  readonly name: string
  readonly ref: string
}

export type Item = {
  readonly file: string
  readonly code: string
  readonly status: Kind
}

export type Stat = {
  readonly file: string
  readonly additions: number
  readonly deletions: number
}

export type Patch = {
  readonly text: string
  readonly truncated: boolean
}

export interface PatchOptions {
  readonly context?: number
  readonly maxOutputBytes?: number
}

export interface Repository {
  readonly root: string
  readonly prefix: string
}

export interface PorcelainStatus {
  readonly entries: Item[]
  readonly paths: string[]
  readonly clean: boolean
}

export interface CommitIdentity {
  readonly name: string
  readonly email: string
}

export interface ScopedCommitInput {
  readonly paths: string[]
  readonly message: string
  readonly author: CommitIdentity
  readonly committer?: CommitIdentity
}

export interface CommitMetadata {
  readonly hash: string
  readonly parents: string[]
  readonly author: CommitIdentity
  readonly committer: CommitIdentity
  readonly subject: string
}

export interface CommitRange {
  readonly base: string
  readonly head: string
  readonly commits: string[]
  readonly paths: string[]
}

export interface MergeSuccess {
  readonly type: "merged"
  readonly commit: string
}

export interface MergeConflict {
  readonly type: "conflict"
  readonly paths: string[]
  readonly diagnostic: string
}

export interface MergeFailure {
  readonly type: "failed"
  readonly diagnostic: string
}

export type MergeResult = MergeSuccess | MergeConflict | MergeFailure

export interface Result {
  readonly exitCode: number
  readonly text: () => string
  readonly stdout: Buffer
  readonly stderr: Buffer
  readonly truncated: boolean
}

export interface Options {
  readonly cwd: string
  readonly env?: Record<string, string>
  readonly maxOutputBytes?: number
  readonly stdin?: ChildProcess.CommandInput
}

export interface Interface {
  readonly run: (args: string[], opts: Options) => Effect.Effect<Result>
  readonly branch: (cwd: string) => Effect.Effect<string | undefined>
  readonly prefix: (cwd: string) => Effect.Effect<string>
  readonly defaultBranch: (cwd: string) => Effect.Effect<Base | undefined>
  readonly hasHead: (cwd: string) => Effect.Effect<boolean>
  readonly mergeBase: (cwd: string, base: string, head?: string) => Effect.Effect<string | undefined>
  readonly show: (cwd: string, ref: string, file: string, prefix?: string) => Effect.Effect<string>
  readonly status: (cwd: string) => Effect.Effect<Item[]>
  readonly diff: (cwd: string, ref: string) => Effect.Effect<Item[]>
  readonly stats: (cwd: string, ref: string) => Effect.Effect<Stat[]>
  readonly patch: (cwd: string, ref: string, file: string, options?: PatchOptions) => Effect.Effect<Patch>
  readonly patchAll: (cwd: string, ref: string, options?: PatchOptions) => Effect.Effect<Patch>
  readonly patchUntracked: (cwd: string, file: string, options?: PatchOptions) => Effect.Effect<Patch>
  readonly statUntracked: (cwd: string, file: string) => Effect.Effect<Stat | undefined>
  readonly applyPatch: (cwd: string, patch: string) => Effect.Effect<Result>
  readonly repository: (cwd: string) => Effect.Effect<Repository | undefined>
  readonly initialize: (cwd: string) => Effect.Effect<Result>
  readonly porcelainStatus: (cwd: string) => Effect.Effect<PorcelainStatus | undefined>
  readonly resolveRef: (cwd: string, ref?: string) => Effect.Effect<string | undefined>
  readonly commitScoped: (cwd: string, input: ScopedCommitInput) => Effect.Effect<Result>
  readonly commitMetadata: (cwd: string, ref: string) => Effect.Effect<CommitMetadata | undefined>
  readonly commitRange: (cwd: string, base: string, head?: string) => Effect.Effect<CommitRange | undefined>
  readonly changedPaths: (cwd: string, from: string, to?: string) => Effect.Effect<string[] | undefined>
  readonly mergeInto: (cwd: string, ref: string) => Effect.Effect<MergeResult>
  readonly abortMerge: (cwd: string) => Effect.Effect<Result>
}

const kind = (code: string): Kind => {
  if (code === "??") return "added"
  if (code.includes("U")) return "modified"
  if (code.includes("A") && !code.includes("D")) return "added"
  if (code.includes("D") && !code.includes("A")) return "deleted"
  return "modified"
}

const diagnostic = (result: Result) => result.stderr.toString("utf8").trim() || out(result) || `git exited ${result.exitCode}`

const validPath = (value: string) => {
  const normalized = value.replace(/\\/g, "/")
  return Boolean(value) && !normalized.startsWith("/") && !normalized.split("/").includes("..") && normalized !== "."
}

const validIdentity = (value: CommitIdentity) => Boolean(value.name.trim() && value.email.trim())

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/Git") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const appProcess = yield* AppProcess.Service
    const encoder = new TextEncoder()
    const stdin = (text: string) => Stream.make(encoder.encode(text))

    const run = Effect.fn("Git.run")(
      function* (args: string[], opts: Options) {
        const result = yield* appProcess.run(
          ChildProcess.make("git", [...cfg, ...args], {
            cwd: opts.cwd,
            env: opts.env,
            extendEnv: true,
            stdin: opts.stdin ?? "ignore",
            stdout: "pipe",
            stderr: "pipe",
          }),
          { maxOutputBytes: opts.maxOutputBytes },
        )
        return {
          exitCode: result.exitCode,
          text: () => result.stdout.toString("utf8"),
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.stdoutTruncated || result.stderrTruncated,
        } satisfies Result
      },
      Effect.catch((err) => Effect.succeed(fail(err))),
    )

    const text = Effect.fn("Git.text")(function* (args: string[], opts: Options) {
      return (yield* run(args, opts)).text()
    })

    const lines = Effect.fn("Git.lines")(function* (args: string[], opts: Options) {
      return (yield* text(args, opts))
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean)
    })

    const refs = Effect.fnUntraced(function* (cwd: string) {
      return yield* lines(["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd })
    })

    const configured = Effect.fnUntraced(function* (cwd: string, list: string[]) {
      const result = yield* run(["config", "init.defaultBranch"], { cwd })
      const name = out(result)
      if (!name || !list.includes(name)) return
      return { name, ref: name } satisfies Base
    })

    const primary = Effect.fnUntraced(function* (cwd: string) {
      const list = yield* lines(["remote"], { cwd })
      if (list.includes("origin")) return "origin"
      if (list.length === 1) return list[0]
      if (list.includes("upstream")) return "upstream"
      return list[0]
    })

    const branch = Effect.fn("Git.branch")(function* (cwd: string) {
      const result = yield* run(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd })
      if (result.exitCode !== 0) return
      const text = out(result)
      return text || undefined
    })

    const prefix = Effect.fn("Git.prefix")(function* (cwd: string) {
      const result = yield* run(["rev-parse", "--show-prefix"], { cwd })
      if (result.exitCode !== 0) return ""
      return out(result)
    })

    const defaultBranch = Effect.fn("Git.defaultBranch")(function* (cwd: string) {
      const remote = yield* primary(cwd)
      if (remote) {
        const head = yield* run(["symbolic-ref", `refs/remotes/${remote}/HEAD`], { cwd })
        if (head.exitCode === 0) {
          const ref = out(head).replace(/^refs\/remotes\//, "")
          const name = ref.startsWith(`${remote}/`) ? ref.slice(`${remote}/`.length) : ""
          if (name) return { name, ref } satisfies Base
        }
      }

      const list = yield* refs(cwd)
      const next = yield* configured(cwd, list)
      if (next) return next
      if (list.includes("main")) return { name: "main", ref: "main" } satisfies Base
      if (list.includes("master")) return { name: "master", ref: "master" } satisfies Base
    })

    const hasHead = Effect.fn("Git.hasHead")(function* (cwd: string) {
      const result = yield* run(["rev-parse", "--verify", "HEAD"], { cwd })
      return result.exitCode === 0
    })

    const mergeBase = Effect.fn("Git.mergeBase")(function* (cwd: string, base: string, head = "HEAD") {
      const result = yield* run(["merge-base", base, head], { cwd })
      if (result.exitCode !== 0) return
      const text = out(result)
      return text || undefined
    })

    const show = Effect.fn("Git.show")(function* (cwd: string, ref: string, file: string, prefix = "") {
      const target = prefix ? `${prefix}${file}` : file
      const result = yield* run(["show", `${ref}:${target}`], { cwd })
      if (result.exitCode !== 0) return ""
      if (result.stdout.includes(0)) return ""
      return result.text()
    })

    const status = Effect.fn("Git.status")(function* (cwd: string) {
      return nuls(
        yield* text(["status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z", "--", "."], {
          cwd,
        }),
      ).flatMap((item) => {
        const file = item.slice(3)
        if (!file) return []
        const code = item.slice(0, 2)
        return [{ file, code, status: kind(code) } satisfies Item]
      })
    })

    const diff = Effect.fn("Git.diff")(function* (cwd: string, ref: string) {
      const list = nuls(
        yield* text(["diff", "--no-ext-diff", "--no-renames", "--name-status", "-z", ref, "--", "."], { cwd }),
      )
      return list.flatMap((code, idx) => {
        if (idx % 2 !== 0) return []
        const file = list[idx + 1]
        if (!code || !file) return []
        return [{ file, code, status: kind(code) } satisfies Item]
      })
    })

    const stats = Effect.fn("Git.stats")(function* (cwd: string, ref: string) {
      return nuls(
        yield* text(["diff", "--no-ext-diff", "--no-renames", "--numstat", "-z", ref, "--", "."], { cwd }),
      ).flatMap((item) => {
        const a = item.indexOf("\t")
        const b = item.indexOf("\t", a + 1)
        if (a === -1 || b === -1) return []
        const file = item.slice(b + 1)
        if (!file) return []
        const adds = item.slice(0, a)
        const dels = item.slice(a + 1, b)
        const additions = adds === "-" ? 0 : Number.parseInt(adds || "0", 10)
        const deletions = dels === "-" ? 0 : Number.parseInt(dels || "0", 10)
        return [
          {
            file,
            additions: Number.isFinite(additions) ? additions : 0,
            deletions: Number.isFinite(deletions) ? deletions : 0,
          } satisfies Stat,
        ]
      })
    })

    const patch = Effect.fn("Git.patch")(function* (cwd: string, ref: string, file: string, options?: PatchOptions) {
      const result = yield* run(
        ["diff", "--patch", "--no-ext-diff", "--no-renames", `--unified=${options?.context ?? 3}`, ref, "--", file],
        { cwd, maxOutputBytes: options?.maxOutputBytes },
      )
      return { text: result.truncated ? "" : result.text(), truncated: result.truncated } satisfies Patch
    })

    const patchAll = Effect.fn("Git.patchAll")(function* (cwd: string, ref: string, options?: PatchOptions) {
      const result = yield* run(
        ["diff", "--patch", "--no-ext-diff", "--no-renames", `--unified=${options?.context ?? 3}`, ref, "--", "."],
        { cwd, maxOutputBytes: options?.maxOutputBytes },
      )
      return { text: result.text(), truncated: result.truncated } satisfies Patch
    })

    const patchUntracked = Effect.fn("Git.patchUntracked")(function* (
      cwd: string,
      file: string,
      options?: PatchOptions,
    ) {
      const result = yield* run(
        [
          "diff",
          "--no-index",
          "--patch",
          "--no-ext-diff",
          "--no-renames",
          `--unified=${options?.context ?? 3}`,
          "--",
          "/dev/null",
          file,
        ],
        { cwd, maxOutputBytes: options?.maxOutputBytes },
      )
      return { text: result.truncated ? "" : result.text(), truncated: result.truncated } satisfies Patch
    })

    const statUntracked = Effect.fn("Git.statUntracked")(function* (cwd: string, file: string) {
      const result = yield* run(["diff", "--no-index", "--numstat", "--", "/dev/null", file], {
        cwd,
        maxOutputBytes: 4096,
      })

      if (result.truncated) return
      const text = result.text()

      const parts = text.split("\t")
      if (parts.length < 2) return

      const additions = parts[0] === "-" ? 0 : Number.parseInt(parts[0] || "0", 10)
      const deletions = parts[1] === "-" ? 0 : Number.parseInt(parts[1] || "0", 10)
      return {
        file,
        additions: Number.isFinite(additions) ? additions : 0,
        deletions: Number.isFinite(deletions) ? deletions : 0,
      } satisfies Stat
    })

    const applyPatch = Effect.fn("Git.applyPatch")(function* (cwd: string, patch: string) {
      return yield* run(["apply", "-"], { cwd, stdin: stdin(patch) })
    })

    const repository = Effect.fn("Git.repository")(function* (cwd: string) {
      const [root, prefix] = yield* Effect.all([
        run(["rev-parse", "--show-toplevel"], { cwd }),
        run(["rev-parse", "--show-prefix"], { cwd }),
      ])
      const value = out(root)
      if (root.exitCode !== 0 || !value) return
      return { root: value, prefix: prefix.exitCode === 0 ? out(prefix) : "" } satisfies Repository
    })

    const initialize = Effect.fn("Git.initialize")(function* (cwd: string) {
      return yield* run(["init"], { cwd })
    })

    const porcelainStatus = Effect.fn("Git.porcelainStatus")(function* (cwd: string) {
      const result = yield* run(["status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z", "--", "."], {
        cwd,
      })
      if (result.exitCode !== 0) return
      const entries = nuls(result.text()).flatMap((item) => {
        const file = item.slice(3)
        if (!file) return []
        const code = item.slice(0, 2)
        return [{ file, code, status: kind(code) } satisfies Item]
      })
      return { entries, paths: entries.map((entry) => entry.file), clean: entries.length === 0 } satisfies PorcelainStatus
    })

    const resolveRef = Effect.fn("Git.resolveRef")(function* (cwd: string, ref = "HEAD") {
      const result = yield* run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd })
      const value = out(result)
      return result.exitCode === 0 && value ? value : undefined
    })

    const commitScoped = Effect.fn("Git.commitScoped")(function* (cwd: string, input: ScopedCommitInput) {
      const paths = [...new Set(input.paths)]
      if (!input.message.trim() || paths.length === 0 || !paths.every(validPath) || !validIdentity(input.author))
        return fail(new Error("Commit requires a message, safe relative paths, and a command-scoped author identity"))
      if (input.committer && !validIdentity(input.committer))
        return fail(new Error("Commit committer identity must include a name and email"))

      const staged = yield* run(["add", "--", ...paths], { cwd })
      if (staged.exitCode !== 0) return staged

      const committer = input.committer ?? input.author
      return yield* run(
        [
          "-c",
          `user.name=${input.author.name}`,
          "-c",
          `user.email=${input.author.email}`,
          "commit",
          "--no-gpg-sign",
          "-m",
          input.message,
          "--",
          ...paths,
        ],
        {
          cwd,
          env: {
            GIT_AUTHOR_NAME: input.author.name,
            GIT_AUTHOR_EMAIL: input.author.email,
            GIT_COMMITTER_NAME: committer.name,
            GIT_COMMITTER_EMAIL: committer.email,
          },
        },
      )
    })

    const commitMetadata = Effect.fn("Git.commitMetadata")(function* (cwd: string, ref: string) {
      const result = yield* run(["show", "-s", "--format=%H%x00%P%x00%an%x00%ae%x00%cn%x00%ce%x00%s", ref], { cwd })
      if (result.exitCode !== 0) return
      const [hash, parentText, authorName, authorEmail, committerName, committerEmail, subject] = nuls(result.text())
      if (!hash || !authorName || !authorEmail || !committerName || !committerEmail || subject === undefined) return
      return {
        hash,
        parents: parentText ? parentText.split(" ") : [],
        author: { name: authorName, email: authorEmail },
        committer: { name: committerName, email: committerEmail },
        subject: subject.trimEnd(),
      } satisfies CommitMetadata
    })

    const changedPaths = Effect.fn("Git.changedPaths")(function* (cwd: string, from: string, to = "HEAD") {
      const result = yield* run(["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", from, to, "--"], { cwd })
      return result.exitCode === 0 ? nuls(result.text()) : undefined
    })

    const commitRange = Effect.fn("Git.commitRange")(function* (cwd: string, base: string, head = "HEAD") {
      const [resolvedBase, resolvedHead] = yield* Effect.all([resolveRef(cwd, base), resolveRef(cwd, head)])
      if (!resolvedBase || !resolvedHead) return
      const [commitsResult, paths] = yield* Effect.all([
        run(["rev-list", "--reverse", `${resolvedBase}..${resolvedHead}`], { cwd }),
        changedPaths(cwd, resolvedBase, resolvedHead),
      ])
      if (commitsResult.exitCode !== 0 || !paths) return
      return {
        base: resolvedBase,
        head: resolvedHead,
        commits: commitsResult.text().split(/\r?\n/).filter(Boolean),
        paths,
      } satisfies CommitRange
    })

    const mergeInto = Effect.fn("Git.mergeInto")(function* (cwd: string, ref: string) {
      const target = yield* resolveRef(cwd, ref)
      if (!target) return { type: "failed", diagnostic: `Cannot resolve merge ref: ${ref}` } satisfies MergeFailure
      const result = yield* run(["merge", "--no-ff", "--no-edit", target], { cwd })
      if (result.exitCode === 0) {
        const commit = yield* resolveRef(cwd)
        return { type: "merged", commit: commit ?? "" } satisfies MergeSuccess
      }
      const conflicts = yield* run(["diff", "--name-only", "--diff-filter=U", "-z"], { cwd })
      const paths = conflicts.exitCode === 0 ? nuls(conflicts.text()) : []
      if (paths.length > 0) return { type: "conflict", paths, diagnostic: diagnostic(result) } satisfies MergeConflict
      return { type: "failed", diagnostic: diagnostic(result) } satisfies MergeFailure
    })

    const abortMerge = Effect.fn("Git.abortMerge")(function* (cwd: string) {
      return yield* run(["merge", "--abort"], { cwd })
    })

    return Service.of({
      run,
      branch,
      prefix,
      defaultBranch,
      hasHead,
      mergeBase,
      show,
      status,
      diff,
      stats,
      patch,
      patchAll,
      patchUntracked,
      statUntracked,
      applyPatch,
      repository,
      initialize,
      porcelainStatus,
      resolveRef,
      commitScoped,
      commitMetadata,
      commitRange,
      changedPaths,
      mergeInto,
      abortMerge,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppProcess.defaultLayer))

export * as Git from "."
