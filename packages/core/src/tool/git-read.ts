export * as GitReadTool from "./git-read"

import { execFile } from "node:child_process"
import path from "node:path"
import { ToolFailure, toolText } from "@deepagent-code/llm"
import { Effect, Layer, Schema } from "effect"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "git_read"

// ---------------------------------------------------------------------------
// Read-only git subcommand allowlist (V1 parity: deepagent-code tool/git_read.ts)
// ---------------------------------------------------------------------------

const ALLOWED_SUBCOMMANDS = new Set([
  "log",
  "diff",
  "show",
  "blame",
  "annotate",
  "status",
  "branch",
  "tag",
  "remote",
  "describe",
  "shortlog",
  "reflog",
  "ls-files",
  "ls-tree",
  "cat-file",
  "rev-parse",
  "rev-list",
  "for-each-ref",
  "grep",
  "name-rev",
  "merge-base",
  "stash",
])

const MAX_OUTPUT_BYTES = 100_000

const FILE_WRITING_OR_EXECUTING_ARGS = [
  /^-o$/,
  /^--output(?:=|$)/,
  /^--ext-diff$/,
  /^--textconv$/,
  /^--filters$/,
  /^--open-files-in-pager(?:=|$)/,
]

/**
 * A subcommand allowlist is not enough: several otherwise read-oriented Git commands also expose
 * mutation or process-execution modes. Pure and directly unit-testable — the permission boundary
 * must not depend on tool runtime state.
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

const Input = Schema.Struct({
  args: Schema.Array(Schema.String).annotate({
    description:
      'Git subcommand and arguments as an array. Examples: ["log", "--oneline", "-20"], ' +
      '["diff", "HEAD~3..HEAD", "--", "src/"], ["blame", "-L", "1,30", "src/foo.ts"], ' +
      '["show", "abc1234"], ["ls-files", "--others", "--exclude-standard"]',
  }),
  directory: Schema.optional(Schema.String).annotate({
    description:
      "Repository directory relative to the active Location. Defaults to the Location root. Absolute paths must resolve inside the Location.",
  }),
})

const Output = Schema.Struct({
  command: Schema.String,
  exitCode: Schema.Number,
  truncated: Schema.Boolean,
  output: Schema.String,
})

/** git_read is Location-contained: the repository directory must resolve inside the active Location. */
const resolveDirectory = (root: string, input: string | undefined) => {
  const resolved = input === undefined ? root : path.isAbsolute(input) ? input : path.join(root, input)
  const normalized = path.resolve(resolved)
  const contained =
    normalized === root || (normalized.startsWith(root.endsWith(path.sep) ? root : root + path.sep) &&
      !normalized.split(path.sep).includes(".."))
  return contained ? normalized : undefined
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "Run read-only Git commands to inspect repository history and content within the active Location. " +
                "Allowed subcommands: log, diff, show, blame, annotate, status, branch, tag, remote, describe, shortlog, reflog, " +
                "ls-files, ls-tree, cat-file, rev-parse, rev-list, for-each-ref, grep, name-rev, merge-base, stash (list/show only). " +
                "Write operations (commit, push, add, reset, checkout -b, etc.) are not available through this tool — " +
                "they require a write-capable agent with the bash tool.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [toolText({ type: "text", text: output.output })],
            execute: (input, context) =>
              Effect.gen(function* () {
                const violation = validateReadOnlyGitArgs(input.args)
                if (violation) {
                  const allowed = [...ALLOWED_SUBCOMMANDS].sort().join(", ")
                  return {
                    command: "git",
                    exitCode: 1,
                    truncated: false,
                    output:
                      `Error: ${violation}. Allowed read-only subcommands: ${allowed}. ` +
                      "Write operations require a write-capable agent with the bash tool.",
                  }
                }
                // validateReadOnlyGitArgs guarantees the subcommand exists.
                const subcommand = input.args[0]!.toLowerCase()

                const cwd = resolveDirectory(location.directory, input.directory)
                if (cwd === undefined)
                  return yield* new ToolFailure({
                    message: "git_read directory must resolve inside the active Location",
                  })

                yield* permission.assert({
                  action: name,
                  resources: [input.args.join(" ")],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                }).pipe(
                  Effect.mapError((error) => {
                    const refusal = PermissionV2.permissionToolFailure(error)
                    if (refusal !== null) return refusal
                    return new ToolFailure({ message: String(error) })
                  }),
                )

                const result = yield* Effect.promise(
                  () =>
                    new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
                      execFile(
                        "git",
                        [...input.args],
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
                  command: `git ${subcommand}`,
                  exitCode: result.exitCode,
                  truncated,
                  output:
                    result.exitCode !== 0 && !result.stdout
                      ? `git exited ${result.exitCode}: ${result.stderr || "(no message)"}`
                      : output,
                }
              }),
          }),
          name,
        ),
      })
      .pipe(Effect.orDie)
  }),
)
