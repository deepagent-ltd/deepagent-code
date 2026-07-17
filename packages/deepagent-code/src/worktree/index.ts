import { Global } from "@deepagent-code/core/global"
import { InstanceLayer } from "@/project/instance-layer"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Database } from "@deepagent-code/core/database/database"
import { eq } from "drizzle-orm"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import type { ProjectV2 } from "@deepagent-code/core/project"
import * as Log from "@deepagent-code/core/util/log"
import { Slug } from "@deepagent-code/core/util/slug"
import { errorMessage } from "../util/error"
import { EventV2 } from "@deepagent-code/core/event"
import { GlobalBus } from "@/bus/global"
import { Git } from "@/git"
import { Effect, Layer, Path, Schema, Scope, Context } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { NodePath } from "@effect/platform-node"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { AppProcess } from "@deepagent-code/core/process"
import { InstanceState } from "@/effect/instance-state"

const log = Log.create({ service: "worktree" })

export const Event = {
  Ready: EventV2.define({
    type: "worktree.ready",
    schema: {
      name: Schema.String,
      branch: Schema.optional(Schema.String),
    },
  }),
  Failed: EventV2.define({
    type: "worktree.failed",
    schema: {
      message: Schema.String,
    },
  }),
}

export const Info = Schema.Struct({
  name: Schema.String,
  branch: Schema.optional(Schema.String),
  directory: Schema.String,
}).annotate({ identifier: "Worktree" })
export type Info = Schema.Schema.Type<typeof Info>

export const CreateInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  startCommand: Schema.optional(
    Schema.String.annotate({ description: "Additional startup script to run after the project's start command" }),
  ),
}).annotate({ identifier: "WorktreeCreateInput" })
export type CreateInput = Schema.Schema.Type<typeof CreateInput>

export const RemoveInput = Schema.Struct({
  directory: Schema.String,
}).annotate({ identifier: "WorktreeRemoveInput" })
export type RemoveInput = Schema.Schema.Type<typeof RemoveInput>

// U3: fail-closed safe-remove input — force overrides the change gate.
export const SafeRemoveInput = Schema.Struct({
  directory: Schema.String,
  force: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "WorktreeSafeRemoveInput" })
export type SafeRemoveInput = Schema.Schema.Type<typeof SafeRemoveInput>

export const ResetInput = Schema.Struct({
  directory: Schema.String,
}).annotate({ identifier: "WorktreeResetInput" })
export type ResetInput = Schema.Schema.Type<typeof ResetInput>

export class NotGitError extends Schema.TaggedErrorClass<NotGitError>()("WorktreeNotGitError", {
  message: Schema.String,
}) {}

export class NameGenerationFailedError extends Schema.TaggedErrorClass<NameGenerationFailedError>()(
  "WorktreeNameGenerationFailedError",
  {
    message: Schema.String,
  },
) {}

export class CreateFailedError extends Schema.TaggedErrorClass<CreateFailedError>()("WorktreeCreateFailedError", {
  message: Schema.String,
}) {}

export class StartCommandFailedError extends Schema.TaggedErrorClass<StartCommandFailedError>()(
  "WorktreeStartCommandFailedError",
  {
    message: Schema.String,
  },
) {}

export class RemoveFailedError extends Schema.TaggedErrorClass<RemoveFailedError>()("WorktreeRemoveFailedError", {
  message: Schema.String,
}) {}

export class ResetFailedError extends Schema.TaggedErrorClass<ResetFailedError>()("WorktreeResetFailedError", {
  message: Schema.String,
}) {}

export class ListFailedError extends Schema.TaggedErrorClass<ListFailedError>()("WorktreeListFailedError", {
  message: Schema.String,
}) {}

// U3: worktree change-count for the fail-closed delete gate, the diff view, branch summary, and
// merge-back. A null count means "indeterminate" (git failed / no baseline) — the caller MUST treat
// that as "has changes, refuse to delete" (borrowed from claude-code countWorktreeChanges).
export const ChangeCount = Schema.Struct({
  // uncommitted working-tree changes (git status --porcelain count); null if indeterminate
  uncommitted: Schema.NullOr(Schema.Number),
  // commits on this worktree's branch not on the base (rev-list base..HEAD); null if indeterminate
  ahead: Schema.NullOr(Schema.Number),
  // true only when BOTH counts are known to be zero — the only safe-to-delete state
  clean: Schema.Boolean,
}).annotate({ identifier: "WorktreeChangeCount" })
export type ChangeCount = Schema.Schema.Type<typeof ChangeCount>

export const DiffEntry = Schema.Struct({
  file: Schema.String,
  status: Schema.String, // added | modified | deleted
  additions: Schema.Number,
  deletions: Schema.Number,
}).annotate({ identifier: "WorktreeDiffEntry" })
export type DiffEntry = Schema.Schema.Type<typeof DiffEntry>

export const DiffResult = Schema.Struct({
  entries: Schema.mutable(Schema.Array(DiffEntry)),
  patch: Schema.String,
  truncated: Schema.Boolean,
}).annotate({ identifier: "WorktreeDiffResult" })
export type DiffResult = Schema.Schema.Type<typeof DiffResult>

export const BranchSummary = Schema.Struct({
  base: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  files: Schema.Number,
}).annotate({ identifier: "WorktreeBranchSummary" })
export type BranchSummary = Schema.Schema.Type<typeof BranchSummary>

export const MergeResult = Schema.Struct({
  merged: Schema.Boolean,
  conflicted: Schema.mutable(Schema.Array(Schema.String)),
  message: Schema.String,
}).annotate({ identifier: "WorktreeMergeResult" })
export type MergeResult = Schema.Schema.Type<typeof MergeResult>

export class MergeFailedError extends Schema.TaggedErrorClass<MergeFailedError>()("WorktreeMergeFailedError", {
  message: Schema.String,
}) {}

export class UnsafeRemoveError extends Schema.TaggedErrorClass<UnsafeRemoveError>()("WorktreeUnsafeRemoveError", {
  message: Schema.String,
}) {}

export type Error =
  | NotGitError
  | NameGenerationFailedError
  | CreateFailedError
  | StartCommandFailedError
  | RemoveFailedError
  | ResetFailedError
  | ListFailedError
  | MergeFailedError
  | UnsafeRemoveError

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}

function failedRemoves(...chunks: string[]) {
  return chunks.filter(Boolean).flatMap((chunk) =>
    chunk
      .split("\n")
      .map((line) => line.trim())
      .flatMap((line) => {
        const match = line.match(/^warning:\s+failed to remove\s+(.+):\s+/i)
        if (!match) return []
        const value = match[1]?.trim().replace(/^['"]|['"]$/g, "")
        if (!value) return []
        return [value]
      }),
  )
}

// ---------------------------------------------------------------------------
// Effect service
// ---------------------------------------------------------------------------

export interface Interface {
  readonly makeWorktreeInfo: (options?: { name?: string; detached?: boolean }) => Effect.Effect<Info, Error>
  readonly createFromInfo: (info: Info, startCommand?: string) => Effect.Effect<void, Error>
  readonly create: (input?: CreateInput) => Effect.Effect<Info, Error>
  readonly list: () => Effect.Effect<(Omit<Info, "branch"> & { branch?: string })[], Error>
  readonly remove: (input: RemoveInput) => Effect.Effect<boolean, Error>
  readonly reset: (input: ResetInput) => Effect.Effect<boolean, Error>
  // U3 (S1 §P0): change-count for the fail-closed delete gate.
  readonly countChanges: (input: RemoveInput) => Effect.Effect<ChangeCount, Error>
  // U3: safe delete — refuses unless countChanges reports clean, OR force is explicitly set.
  readonly safeRemove: (input: RemoveInput & { force?: boolean }) => Effect.Effect<boolean, Error>
  // U3: tracked + untracked diff for the worktree (reuses Git.Service).
  readonly diff: (input: RemoveInput) => Effect.Effect<DiffResult, Error>
  // U3: branch summary (merge-base + numstat against the default branch).
  readonly branchSummary: (input: RemoveInput) => Effect.Effect<BranchSummary, Error>
  // U3: merge the worktree branch back to the default branch (preflight + no auto-commit).
  readonly mergeBack: (input: RemoveInput) => Effect.Effect<MergeResult, Error>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/Worktree") {}

type GitResult = { code: number; text: string; stderr: string }

// I33-5: build the argument list for a HARDENED read-only git invocation inside a possibly
// attacker-controlled worktree. Neutralizes the content-driven code paths git otherwise runs on
// ordinary reads (each empirically verified against a hostile repo):
//   - `-c core.hooksPath=/dev/null` → no hook execution (any subcommand)
//   - `diff --no-ext-diff`          → ignore any `[diff "x"] external=` driver (use git's built-in diff)
//   - `diff --no-textconv`          → ignore any `[diff "x"] textconv=` filter
// `--no-ext-diff` / `--no-textconv` are DIFF-SUBCOMMAND flags (they must follow `diff`, and status/
// rev-list reject them), so they are appended only for the diff subcommand. NOTE: an empty
// `-c diff.external=` does NOT work — git then tries to execute the empty string and dies with
// "cannot run"; `--no-ext-diff` is the correct neutralizer.
// Clean/smudge/process filters (`[filter "x"] clean=/process=`) are keyed by ATTACKER-CHOSEN names and
// cannot be disabled by name; the mitigation is behavioral — safeGit only runs read ops (status
// --porcelain / diff --numstat / rev-list) that never add or canonicalize worktree content, so clean
// filters are never invoked. safeGit must NEVER be used for `git add`/checkout. Exported pure so the
// hardening is unit-testable without the full worktree layer.
export const hardenedGitArgs = (args: readonly string[]): string[] => {
  const hooks = ["-c", "core.hooksPath=/dev/null"]
  return args[0] === "diff"
    ? [...hooks, "diff", "--no-ext-diff", "--no-textconv", ...args.slice(1)]
    : [...hooks, ...args]
}

export const layer: Layer.Layer<
  Service,
  never,
  | FSUtil.Service
  | Path.Path
  | AppProcess.Service
  | Git.Service
  | Project.Service
  | InstanceStore.Service
  | Database.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const fs = yield* FSUtil.Service
    const pathSvc = yield* Path.Path
    const appProcess = yield* AppProcess.Service
    const { db } = yield* Database.Service
    const gitSvc = yield* Git.Service
    const project = yield* Project.Service
    const store = yield* InstanceStore.Service

    const git = Effect.fnUntraced(
      function* (args: string[], opts?: { cwd?: string }) {
        const result = yield* appProcess.run(
          ChildProcess.make("git", args, { cwd: opts?.cwd, extendEnv: true, stdin: "ignore" }),
        )
        return {
          code: result.exitCode,
          text: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        } satisfies GitResult
      },
      Effect.catch((e) =>
        Effect.succeed({
          code: 1,
          text: "",
          stderr: e instanceof Error ? e.message : String(e),
        } satisfies GitResult),
      ),
    )

    const MAX_NAME_ATTEMPTS = 26
    const candidate = Effect.fn("Worktree.candidate")(function* (input: {
      root: string
      name?: string
      detached?: boolean
    }) {
      const ctx = yield* InstanceState.context
      for (const attempt of Array.from({ length: MAX_NAME_ATTEMPTS }, (_, i) => i)) {
        const name = input.name ? (attempt === 0 ? input.name : `${input.name}-${Slug.create()}`) : Slug.create()
        const branch = input.detached ? undefined : `deepagent-code/${name}`
        const directory = pathSvc.join(input.root, name)

        if (yield* fs.exists(directory).pipe(Effect.orDie)) continue

        if (branch) {
          const ref = `refs/heads/${branch}`
          const branchCheck = yield* git(["show-ref", "--verify", "--quiet", ref], { cwd: ctx.worktree })
          if (branchCheck.code === 0) continue
        }

        return { name, directory, ...(branch ? { branch } : {}) }
      }
      return yield* new NameGenerationFailedError({ message: "Failed to generate a unique worktree name" })
    })

    const makeWorktreeInfo = Effect.fn("Worktree.makeWorktreeInfo")(function* (input?: {
      name?: string
      detached?: boolean
    }) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      }

      const root = pathSvc.join(Global.Path.data, "worktree", ctx.project.id)
      yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.orDie)

      return yield* candidate({ root, name: input?.name ? slugify(input.name) : "", detached: input?.detached })
    })

    const setup = Effect.fnUntraced(function* (info: Info) {
      const ctx = yield* InstanceState.context
      const created = yield* git(
        info.branch
          ? ["worktree", "add", "--no-checkout", "-b", info.branch, info.directory]
          : ["worktree", "add", "--no-checkout", "--detach", info.directory, "HEAD"],
        { cwd: ctx.worktree },
      )
      if (created.code !== 0) {
        return yield* new CreateFailedError({
          message: created.stderr || created.text || "Failed to create git worktree",
        })
      }

      yield* project.addSandbox(ctx.project.id, info.directory).pipe(Effect.catch(() => Effect.void))
    })

    const boot = Effect.fnUntraced(function* (info: Info, startCommand?: string) {
      const ctx = yield* InstanceState.context
      const workspaceID = yield* InstanceState.workspaceID
      const projectID = ctx.project.id
      const extra = startCommand?.trim()

      const populated = yield* git(["reset", "--hard"], { cwd: info.directory })
      if (populated.code !== 0) {
        const message = populated.stderr || populated.text || "Failed to populate worktree"
        log.error("worktree checkout failed", { directory: info.directory, message })
        GlobalBus.emit("event", {
          directory: info.directory,
          project: ctx.project.id,
          workspace: workspaceID,
          payload: { type: Event.Failed.type, properties: { message } },
        })
        return
      }

      const booted = yield* store.load({ directory: info.directory }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.sync(() => {
            const message = errorMessage(error)
            log.error("worktree bootstrap failed", { directory: info.directory, message })
            GlobalBus.emit("event", {
              directory: info.directory,
              project: ctx.project.id,
              workspace: workspaceID,
              payload: { type: Event.Failed.type, properties: { message } },
            })
            return false
          }),
        ),
      )
      if (!booted) return

      GlobalBus.emit("event", {
        directory: info.directory,
        project: ctx.project.id,
        workspace: workspaceID,
        payload: {
          type: Event.Ready.type,
          properties: { name: info.name, ...(info.branch ? { branch: info.branch } : {}) },
        },
      })

      yield* runStartScripts(info.directory, { projectID, extra })
    })

    const createFromInfo = Effect.fn("Worktree.createFromInfo")(function* (info: Info, startCommand?: string) {
      yield* setup(info)
      yield* boot(info, startCommand).pipe(
        Effect.catchCause((cause) => Effect.sync(() => log.error("worktree bootstrap failed", { cause }))),
        Effect.forkIn(scope),
      )
    })

    const create = Effect.fn("Worktree.create")(function* (input?: CreateInput) {
      const info = yield* makeWorktreeInfo({ name: input?.name })
      yield* createFromInfo(info, input?.startCommand)
      return info
    })

    const canonical = Effect.fnUntraced(function* (input: string) {
      const abs = pathSvc.resolve(input)
      const real = yield* fs.realPath(abs).pipe(Effect.catch(() => Effect.succeed(abs)))
      const normalized = pathSvc.normalize(real)
      return process.platform === "win32" ? normalized.toLowerCase() : normalized
    })

    function parseWorktreeList(text: string) {
      return text
        .split("\n")
        .map((line) => line.trim())
        .reduce<{ path?: string; branch?: string }[]>((acc, line) => {
          if (!line) return acc
          if (line.startsWith("worktree ")) {
            acc.push({ path: line.slice("worktree ".length).trim() })
            return acc
          }
          const current = acc[acc.length - 1]
          if (!current) return acc
          if (line.startsWith("branch ")) {
            current.branch = line.slice("branch ".length).trim()
          }
          return acc
        }, [])
    }

    const locateWorktree = Effect.fnUntraced(function* (
      entries: { path?: string; branch?: string }[],
      directory: string,
    ) {
      for (const item of entries) {
        if (!item.path) continue
        const key = yield* canonical(item.path)
        if (key === directory) return item
      }
      return undefined
    })

    const list = Effect.fn("Worktree.list")(function* () {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return []
      }

      const result = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (result.code !== 0) {
        return yield* new ListFailedError({ message: result.stderr || result.text || "Failed to read git worktrees" })
      }

      const primary = yield* canonical(ctx.project.worktree)
      const primaryName = pathSvc.basename(primary).toLowerCase()
      return yield* Effect.forEach(parseWorktreeList(result.text), (entry) =>
        Effect.gen(function* () {
          if (!entry.path) return undefined
          const directory = yield* canonical(entry.path)
          if (directory === primary) return undefined
          const name = pathSvc.basename(directory).toLowerCase()
          return {
            name: name === primaryName ? pathSvc.basename(pathSvc.dirname(directory)) : name,
            directory,
            ...(entry.branch ? { branch: entry.branch.replace(/^refs\/heads\//, "") } : {}),
          }
        }),
      ).pipe(Effect.map((items) => items.filter((item) => item !== undefined)))
    })

    function stopFsmonitor(target: string) {
      return fs.exists(target).pipe(
        Effect.orDie,
        Effect.flatMap((exists) => (exists ? git(["fsmonitor--daemon", "stop"], { cwd: target }) : Effect.void)),
      )
    }

    function cleanDirectory(target: string) {
      return Effect.tryPromise({
        try: async () => {
          const fsp = await import("fs/promises")
          const attempts = process.platform === "win32" ? 50 : 5
          for (const attempt of Array.from({ length: attempts }, (_, i) => i)) {
            try {
              await fsp.rm(target, { recursive: true, force: true })
              return
            } catch (error) {
              if (attempt === attempts - 1) throw error
              await new Promise((resolve) => setTimeout(resolve, 100))
            }
          }
        },
        catch: (error) =>
          new RemoveFailedError({ message: errorMessage(error) || "Failed to remove git worktree directory" }),
      })
    }

    const remove = Effect.fn("Worktree.remove")(function* (input: RemoveInput) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      }

      const directory = yield* canonical(input.directory)

      // Preserve the loaded path casing for the store cache; `directory` is lowercased on Windows.
      if (directory !== (yield* canonical(ctx.worktree))) yield* store.disposeDirectory(input.directory)

      const list = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (list.code !== 0) {
        return yield* new RemoveFailedError({ message: list.stderr || list.text || "Failed to read git worktrees" })
      }

      const entries = parseWorktreeList(list.text)
      const entry = yield* locateWorktree(entries, directory)

      if (!entry?.path) {
        const directoryExists = yield* fs.exists(directory).pipe(Effect.orDie)
        if (directoryExists) {
          yield* stopFsmonitor(directory)
          yield* cleanDirectory(directory)
        }
        return true
      }

      // Git may return the original casing when a caller supplied a normalized Windows path.
      yield* store.disposeDirectory(entry.path)
      yield* stopFsmonitor(entry.path)
      const removed = yield* git(["worktree", "remove", "--force", entry.path], { cwd: ctx.worktree })
      if (removed.code !== 0) {
        const next = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
        if (next.code !== 0) {
          return yield* new RemoveFailedError({
            message: removed.stderr || removed.text || next.stderr || next.text || "Failed to remove git worktree",
          })
        }

        const stale = yield* locateWorktree(parseWorktreeList(next.text), directory)
        if (stale?.path) {
          return yield* new RemoveFailedError({
            message: removed.stderr || removed.text || "Failed to remove git worktree",
          })
        }
      }

      yield* cleanDirectory(entry.path)

      const branch = entry.branch?.replace(/^refs\/heads\//, "")
      if (branch) {
        const deleted = yield* git(["branch", "-D", branch], { cwd: ctx.worktree })
        if (deleted.code !== 0) {
          return yield* new RemoveFailedError({
            message: deleted.stderr || deleted.text || "Failed to delete worktree branch",
          })
        }
      }

      return true
    })

    const gitExpect = Effect.fnUntraced(function* (
      args: string[],
      opts: { cwd: string },
      error: (r: GitResult) => Error,
    ) {
      const result = yield* git(args, opts)
      if (result.code !== 0) return yield* error(result)
      return result
    })

    const runStartCommand = Effect.fnUntraced(
      function* (directory: string, cmd: string) {
        const [shell, args] = process.platform === "win32" ? ["cmd", ["/c", cmd]] : ["bash", ["-lc", cmd]]
        const result = yield* appProcess.run(
          ChildProcess.make(shell, args as string[], { cwd: directory, extendEnv: true, stdin: "ignore" }),
        )
        return { code: result.exitCode, stderr: result.stderr.toString("utf8") }
      },
      Effect.catch(() => Effect.succeed({ code: 1, stderr: "" })),
    )

    const runStartScript = Effect.fnUntraced(function* (directory: string, cmd: string, kind: string) {
      const text = cmd.trim()
      if (!text) return true
      const result = yield* runStartCommand(directory, text)
      if (result.code === 0) return true
      log.error("worktree start command failed", { kind, directory, message: result.stderr })
      return false
    })

    const runStartScripts = Effect.fnUntraced(function* (
      directory: string,
      input: { projectID: ProjectV2.ID; extra?: string },
    ) {
      const row = yield* db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, input.projectID))
        .get()
        .pipe(Effect.orDie)
      const project = row ? Project.fromRow(row) : undefined
      const startup = project?.commands?.start?.trim() ?? ""
      const ok = yield* runStartScript(directory, startup, "project")
      if (!ok) return false
      yield* runStartScript(directory, input.extra ?? "", "worktree")
      return true
    })

    const prune = Effect.fnUntraced(function* (root: string, entries: string[]) {
      const base = yield* canonical(root)
      yield* Effect.forEach(
        entries,
        (entry) =>
          Effect.gen(function* () {
            const target = yield* canonical(pathSvc.resolve(root, entry))
            if (target === base) return
            if (!target.startsWith(`${base}${pathSvc.sep}`)) return
            yield* fs.remove(target, { recursive: true }).pipe(Effect.ignore)
          }),
        { concurrency: "unbounded" },
      )
    })

    const sweep = Effect.fnUntraced(function* (root: string) {
      const first = yield* git(["clean", "-ffdx"], { cwd: root })
      if (first.code === 0) return first

      const entries = failedRemoves(first.stderr, first.text)
      if (!entries.length) return first

      yield* prune(root, entries)
      return yield* git(["clean", "-ffdx"], { cwd: root })
    })

    const reset = Effect.fn("Worktree.reset")(function* (input: ResetInput) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      }

      const directory = yield* canonical(input.directory)
      const primary = yield* canonical(ctx.worktree)
      if (directory === primary) {
        return yield* new ResetFailedError({ message: "Cannot reset the primary workspace" })
      }

      const list = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (list.code !== 0) {
        return yield* new ResetFailedError({ message: list.stderr || list.text || "Failed to read git worktrees" })
      }

      const entry = yield* locateWorktree(parseWorktreeList(list.text), directory)
      if (!entry?.path) {
        return yield* new ResetFailedError({ message: "Worktree not found" })
      }

      const worktreePath = entry.path

      const base = yield* gitSvc.defaultBranch(ctx.worktree)
      if (!base) {
        return yield* new ResetFailedError({ message: "Default branch not found" })
      }

      const sep = base.ref.indexOf("/")
      if (base.ref !== base.name && sep > 0) {
        const remote = base.ref.slice(0, sep)
        const branch = base.ref.slice(sep + 1)
        yield* gitExpect(
          ["fetch", remote, branch],
          { cwd: ctx.worktree },
          (r) => new ResetFailedError({ message: r.stderr || r.text || `Failed to fetch ${base.ref}` }),
        )
      }

      yield* gitExpect(
        ["reset", "--hard", base.ref],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to reset worktree to target" }),
      )

      const cleanResult = yield* sweep(worktreePath)
      if (cleanResult.code !== 0) {
        return yield* new ResetFailedError({
          message: cleanResult.stderr || cleanResult.text || "Failed to clean worktree",
        })
      }

      yield* gitExpect(
        ["submodule", "update", "--init", "--recursive", "--force"],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to update submodules" }),
      )

      yield* gitExpect(
        ["submodule", "foreach", "--recursive", "git", "reset", "--hard"],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to reset submodules" }),
      )

      yield* gitExpect(
        ["submodule", "foreach", "--recursive", "git", "clean", "-fdx"],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to clean submodules" }),
      )

      const status = yield* git(["-c", "core.fsmonitor=false", "status", "--porcelain=v1"], { cwd: worktreePath })
      if (status.code !== 0) {
        return yield* new ResetFailedError({ message: status.stderr || status.text || "Failed to read git status" })
      }

      if (status.text.trim()) {
        return yield* new ResetFailedError({ message: `Worktree reset left local changes:\n${status.text.trim()}` })
      }

      yield* runStartScripts(worktreePath, { projectID: ctx.project.id }).pipe(
        Effect.catchCause((cause) => Effect.sync(() => log.error("worktree start task failed", { cause }))),
        Effect.forkIn(scope),
      )

      return true
    })

    // U3 / I33-5: read-only git for informational reads inside a possibly attacker-controlled worktree.
    // Hardening (hooks + external-diff + textconv neutralized) lives in the exported pure
    // `hardenedGitArgs` so it is unit-testable; see its comment for the threat model. safeGit must only
    // ever run read ops (status/diff/rev-list), never `git add`/checkout.
    const safeGit = (args: string[], cwd: string) => git(hardenedGitArgs(args), { cwd })

    // U3: locate a worktree entry by directory, the shared lookup the new ops need.
    const resolveEntry = Effect.fnUntraced(function* (directory: string) {
      const ctx = yield* InstanceState.context
      const listResult = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (listResult.code !== 0) return undefined
      const canon = yield* canonical(directory)
      const entry = yield* locateWorktree(parseWorktreeList(listResult.text), canon)
      return entry?.path ? { path: entry.path, branch: entry.branch?.replace(/^refs\/heads\//, "") } : undefined
    })

    // U3 (claude-code countWorktreeChanges, fail-closed): count uncommitted changes + commits ahead
    // of the base. ANY indeterminate result (git error / missing base) yields null counts and
    // clean=false, so the delete gate treats "unknown" as "unsafe".
    const countChanges = Effect.fn("Worktree.countChanges")(function* (input: RemoveInput) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git")
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      const entry = yield* resolveEntry(input.directory)
      if (!entry) return { uncommitted: null, ahead: null, clean: false } satisfies ChangeCount

      const status = yield* safeGit(["status", "--porcelain"], entry.path)
      const uncommitted = status.code === 0 ? status.text.split("\n").filter((l) => l.trim()).length : null

      // ahead count needs a base ref; merge-base against the default branch, then rev-list base..HEAD
      let ahead: number | null = null
      const base = yield* gitSvc.defaultBranch(entry.path).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (base) {
        const mb = yield* gitSvc.mergeBase(entry.path, base.ref).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (mb) {
          const rev = yield* safeGit(["rev-list", "--count", `${mb}..HEAD`], entry.path)
          if (rev.code === 0) {
            const n = Number(rev.text.trim())
            ahead = Number.isFinite(n) ? n : null
          }
        }
      }
      const clean = uncommitted === 0 && ahead === 0
      return { uncommitted, ahead, clean } satisfies ChangeCount
    })

    // U3: delete only when clean, unless force. Refuses (UnsafeRemoveError) on any uncertainty.
    const safeRemove = Effect.fn("Worktree.safeRemove")(function* (input: RemoveInput & { force?: boolean }) {
      if (!input.force) {
        const count = yield* countChanges({ directory: input.directory })
        if (!count.clean) {
          const detail =
            count.uncommitted === null || count.ahead === null
              ? "could not determine worktree state (treated as unsafe)"
              : `${count.uncommitted} uncommitted change(s), ${count.ahead} unmerged commit(s)`
          return yield* new UnsafeRemoveError({
            message: `Refusing to remove worktree: ${detail}. Merge or discard first, or pass force to delete anyway.`,
          })
        }
      }
      return yield* remove({ directory: input.directory })
    })

    // U3: tracked + untracked diff for the worktree, reusing Git.Service (status for the change list,
    // patchAll for the unified diff against HEAD). No parallel git plumbing.
    const diff = Effect.fn("Worktree.diff")(function* (input: RemoveInput) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git")
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      const entry = yield* resolveEntry(input.directory)
      if (!entry) return yield* new ListFailedError({ message: "Worktree not found" })

      const stats = yield* gitSvc.stats(entry.path, "HEAD").pipe(Effect.catch(() => Effect.succeed([] as const)))
      const status = yield* gitSvc.status(entry.path).pipe(Effect.catch(() => Effect.succeed([] as const)))
      const statByFile = new Map(stats.map((s) => [s.file, s]))
      const entries: DiffEntry[] = status.map((item) => {
        const s = statByFile.get(item.file)
        return { file: item.file, status: item.status, additions: s?.additions ?? 0, deletions: s?.deletions ?? 0 }
      })
      const patch = yield* gitSvc
        .patchAll(entry.path, "HEAD")
        .pipe(Effect.catch(() => Effect.succeed({ text: "", truncated: false })))
      return { entries, patch: patch.text, truncated: patch.truncated } satisfies DiffResult
    })

    // U3 (codex branch_summary): merge-base against the default branch + numstat sum of committed
    // branch work. Ignores the dirty tree on purpose — it summarizes the branch, not the worktree.
    const branchSummary = Effect.fn("Worktree.branchSummary")(function* (input: RemoveInput) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git")
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      const entry = yield* resolveEntry(input.directory)
      if (!entry) return yield* new ListFailedError({ message: "Worktree not found" })

      const base = yield* gitSvc.defaultBranch(entry.path).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!base) return { base: "", additions: 0, deletions: 0, files: 0 } satisfies BranchSummary
      const mb = yield* gitSvc.mergeBase(entry.path, base.ref).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!mb) return { base: base.name, additions: 0, deletions: 0, files: 0 } satisfies BranchSummary

      const numstat = yield* safeGit(["diff", "--numstat", `${mb}..HEAD`], entry.path)
      let additions = 0
      let deletions = 0
      let files = 0
      if (numstat.code === 0) {
        for (const line of numstat.text.split("\n")) {
          const m = line.trim().match(/^(\d+|-)\t(\d+|-)\t/)
          if (!m) continue
          files++
          if (m[1] !== "-") additions += Number(m[1])
          if (m[2] !== "-") deletions += Number(m[2])
        }
      }
      return { base: base.name, additions, deletions, files } satisfies BranchSummary
    })

    // U3: merge the worktree branch back into the default branch. Uses --no-commit --no-ff so the
    // merge is staged for the user to confirm; on conflict it aborts and reports the conflicted
    // files. Merging is an outward-facing write — callers gate it behind explicit user confirmation.
    const mergeBack = Effect.fn("Worktree.mergeBack")(function* (input: RemoveInput) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git")
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      const entry = yield* resolveEntry(input.directory)
      if (!entry?.branch) return yield* new MergeFailedError({ message: "Worktree has no branch to merge" })

      const base = yield* gitSvc.defaultBranch(ctx.worktree).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!base) return yield* new MergeFailedError({ message: "Default branch not found" })

      const merge = yield* git(["merge", "--no-commit", "--no-ff", entry.branch], { cwd: ctx.worktree })
      if (merge.code !== 0) {
        const conflicts = yield* safeGit(["diff", "--name-only", "--diff-filter=U"], ctx.worktree)
        const files =
          conflicts.code === 0
            ? conflicts.text
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean)
            : []
        yield* git(["merge", "--abort"], { cwd: ctx.worktree }).pipe(Effect.ignore)
        return {
          merged: false,
          conflicted: files,
          message: files.length
            ? `Merge has conflicts in ${files.length} file(s); merge aborted.`
            : merge.stderr || merge.text || "Merge failed.",
        } satisfies MergeResult
      }
      return {
        merged: true,
        conflicted: [],
        message: `Merged ${entry.branch} into ${base.name} (staged, not committed).`,
      } satisfies MergeResult
    })

    return Service.of({
      makeWorktreeInfo,
      createFromInfo,
      create,
      list,
      remove,
      reset,
      countChanges,
      safeRemove,
      diff,
      branchSummary,
      mergeBack,
    })
  }),
)

export const appLayer = layer.pipe(
  Layer.provide(Git.defaultLayer),
  Layer.provide(AppProcess.defaultLayer),
  Layer.provide(Project.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(NodePath.layer),
)

export const defaultLayer = appLayer.pipe(Layer.provide(InstanceLayer.layer))

export * as Worktree from "."
