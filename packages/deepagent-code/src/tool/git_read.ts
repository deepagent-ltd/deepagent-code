/**
 * git_read: read-only Git operations for researcher/explore subagents.
 *
 * Permission name: "git_read" (intentionally absent from EDIT_CLASS_PERMISSIONS,
 * so subagentIsWriteType() returns false for agents that only hold this permission —
 * see BUG-405-001 Fix-A in agent.ts).
 *
 * Implementation note: this tool uses Node's child_process.execFile directly rather
 * than Git.Service so that it adds no new service requirement to the tool registry's
 * layerWithFacades, keeping the layer dependency graph stable.
 */
import { execFile } from "node:child_process"
import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Tool from "./tool"

// ---------------------------------------------------------------------------
// Read-only git subcommand allowlist
// ---------------------------------------------------------------------------
const ALLOWED_SUBCOMMANDS = new Set([
  "log", // commit history
  "diff", // diffs between commits, branches, files
  "show", // show commit/tag/tree/blob content
  "blame", // line-by-line attribution
  "annotate", // alias for blame
  "status", // working tree status (query only)
  "branch", // list branches
  "tag", // list tags
  "remote", // list/show remotes
  "describe", // describe a commit by nearest tag
  "shortlog", // summarized commit history
  "reflog", // reference log
  "ls-files", // list tracked/untracked files in index
  "ls-tree", // list contents of a tree object
  "cat-file", // show type, size, or content of a git object
  "rev-parse", // parse revision/object identifiers
  "rev-list", // list commit objects reachable from a given commit
  "for-each-ref", // iterate over refs with custom formatting
  "grep", // search in working tree / tracked blobs
  "name-rev", // find symbolic names for revisions
  "merge-base", // find the common ancestor of two commits
  "stash", // stash list/show only (validated below)
])

const MAX_OUTPUT_BYTES = 100_000 // ~100 kB

type Metadata = {
  readonly exitCode?: number
  readonly truncated: boolean
  readonly blocked: boolean
}

const FILE_WRITING_OR_EXECUTING_ARGS = [
  /^-o$/,
  /^--output(?:=|$)/,
  /^--ext-diff$/,
  /^--textconv$/,
  /^--filters$/,
  /^--open-files-in-pager(?:=|$)/,
]

/**
 * A subcommand allowlist is not enough: several otherwise read-oriented Git
 * commands also expose mutation or process-execution modes. Keep this check
 * independent from the tool runtime so the permission boundary is directly
 * unit-testable.
 */
export function validateReadOnlyGitArgs(args: readonly string[]): string | undefined {
  const [rawSubcommand, ...rest] = args
  if (!rawSubcommand) return "no git subcommand specified"

  const subcommand = rawSubcommand.toLowerCase()
  if (!ALLOWED_SUBCOMMANDS.has(subcommand)) return `git subcommand "${rawSubcommand}" is not permitted`

  const unsafe = rest.find((arg) => FILE_WRITING_OR_EXECUTING_ARGS.some((pattern) => pattern.test(arg)))
  if (unsafe) return `argument "${unsafe}" can write a file or execute a configured program`

  if (subcommand === "branch") {
    const mutating = rest.find((arg) =>
      /^(?:-[dDmMcCf]|--delete|--move|--copy|--force|--edit-description|--set-upstream-to|--unset-upstream)$/u.test(
        arg,
      ),
    )
    if (mutating) return `git branch argument "${mutating}" is mutating`
    const queryMode = rest.some((arg) =>
      /^(?:--list|-l|-a|--all|-r|--remotes|-v|-vv|--show-current|--contains|--no-contains|--merged|--no-merged|--points-at|--format|--sort|--column|--no-column)(?:=|$)/u.test(
        arg,
      ),
    )
    if (rest.length > 0 && !queryMode) return "git branch arguments must select a listing/query mode"
  }

  if (subcommand === "tag") {
    const mutating = rest.find((arg) =>
      /^(?:-[dsaumf]|--delete|--sign|--annotate|--local-user|--message|--file|--force|--create-reflog)(?:=|$)/u.test(
        arg,
      ),
    )
    if (mutating) return `git tag argument "${mutating}" is mutating`
    const queryMode = rest.some((arg) =>
      /^(?:--list|-l|-n|--contains|--no-contains|--merged|--no-merged|--points-at|--format|--sort|--column|--no-column)(?:=|$)/u.test(
        arg,
      ),
    )
    if (rest.length > 0 && !queryMode) return "git tag arguments must select a listing/query mode"
  }

  if (subcommand === "remote") {
    const mode = rest[0]
    if (mode && !["-v", "--verbose", "get-url", "show"].includes(mode)) {
      return `git remote mode "${mode}" is not read-only`
    }
  }

  if (subcommand === "reflog") {
    const mode = rest.find((arg) => !arg.startsWith("-"))
    if (mode && !["show", "exists"].includes(mode)) return `git reflog mode "${mode}" is mutating`
  }

  if (subcommand === "stash") {
    const mode = rest[0]
    if (!mode || !["list", "show"].includes(mode)) {
      return `git stash${mode ? ` ${mode}` : ""} is mutating; only list and show are permitted`
    }
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const Parameters = Schema.Struct({
  args: Schema.Array(Schema.String).annotate({
    description:
      'Git subcommand and arguments as an array. Examples: ["log", "--oneline", "-20"], ' +
      '["diff", "HEAD~3..HEAD", "--", "src/"], ["blame", "-L", "1,30", "src/foo.ts"], ' +
      '["show", "abc1234"], ["ls-files", "--others", "--exclude-standard"]',
  }),
  directory: Schema.optional(Schema.String).annotate({
    description:
      "Repository directory. Defaults to the session working directory. " +
      "Accepts an absolute path or a path relative to the session directory.",
  }),
})

export const GitReadTool = Tool.define<typeof Parameters, Metadata, never>(
  "git_read",
  Effect.gen(function* () {
    return {
      description:
        "Run read-only Git commands to inspect repository history and content. " +
        "Allowed subcommands: log, diff, show, blame, annotate, status, branch, tag, " +
        "remote, describe, shortlog, reflog, ls-files, ls-tree, cat-file, rev-parse, " +
        "rev-list, for-each-ref, grep, name-rev, merge-base, stash (list/show only). " +
        "Write operations (commit, push, add, reset, checkout -b, etc.) are not available " +
        "through this tool — they require a write-capable agent with the bash tool.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const [subcommand, ...rest] = params.args

          const violation = validateReadOnlyGitArgs(params.args)
          if (violation) {
            const allowed = [...ALLOWED_SUBCOMMANDS].sort().join(", ")
            return {
              title: subcommand ? `git ${subcommand}` : "git",
              metadata: { blocked: true, truncated: false } satisfies Metadata,
              output:
                `Error: ${violation}. ` +
                `Allowed read-only subcommands: ${allowed}. ` +
                `Write operations require a write-capable agent with the bash tool.`,
            }
          }

          // validateReadOnlyGitArgs guarantees this value exists.
          const normalized = subcommand!.toLowerCase()

          yield* ctx.ask({
            permission: "git_read",
            patterns: [params.args.join(" ")],
            always: ["*"],
            metadata: { subcommand, args: params.args },
          })

          const ins = yield* InstanceState.context
          const cwd =
            params.directory == null
              ? ins.directory
              : path.isAbsolute(params.directory)
                ? params.directory
                : path.join(ins.directory, params.directory)

          yield* assertExternalDirectoryEffect(ctx, cwd, { kind: "directory" })

          // Run git via execFile — no Effect Git.Service needed at init time
          const result = yield* Effect.promise(
            () =>
              new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
                execFile(
                  "git",
                  [normalized, ...rest],
                  {
                    cwd,
                    maxBuffer: MAX_OUTPUT_BYTES * 2,
                    env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat" },
                  },
                  (err, stdout, stderr) => {
                    const code = (err as NodeJS.ErrnoException | null)?.code
                    resolve({
                      exitCode: typeof code === "number" ? code : err ? 1 : 0,
                      stdout: stdout ?? "",
                      stderr: (stderr ?? "").trim(),
                    })
                  },
                )
              }),
          )

          const raw = result.stdout || (result.exitCode !== 0 ? result.stderr : "") || "(no output)"
          const truncated = raw.length > MAX_OUTPUT_BYTES
          const output = truncated ? raw.slice(0, MAX_OUTPUT_BYTES) + "\n...(output truncated)" : raw

          return {
            title: `git ${normalized}`,
            metadata: { blocked: false, exitCode: result.exitCode, truncated } satisfies Metadata,
            output:
              result.exitCode !== 0 && !result.stdout
                ? `git exited ${result.exitCode}: ${result.stderr || "(no message)"}`
                : output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
