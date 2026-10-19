export * as VcsOverview from "./vcs-overview"

import { Duration, Effect, Schema } from "effect"
import { Git } from "@/git"

const limits = { bytes: 4 * 1024 * 1024, files: 1000, refs: 2000, milliseconds: 15_000 }

export const Ref = Schema.Struct({
  name: Schema.String,
  ref: Schema.String,
  oid: Schema.String,
  kind: Schema.Literals(["local", "remote"]),
}).annotate({ identifier: "VcsRef" })
export type Ref = typeof Ref.Type

export const Refs = Schema.Struct({
  directory: Schema.String,
  repositoryRoot: Schema.NullOr(Schema.String),
  observedAt: Schema.Finite,
  items: Schema.Array(Ref),
  truncated: Schema.Boolean,
}).annotate({ identifier: "VcsRefs" })

export const WorkSummary = Schema.Struct({
  directory: Schema.String,
  repositoryRoot: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  headOID: Schema.NullOr(Schema.String),
  baseRef: Schema.NullOr(Schema.String),
  baseOID: Schema.NullOr(Schema.String),
  mergeBaseOID: Schema.NullOr(Schema.String),
  startedAt: Schema.Finite,
  observedAt: Schema.Finite,
  state: Schema.Literals(["ready", "non_git", "unborn", "base_unavailable", "no_common_ancestor", "unavailable"]),
  coverage: Schema.Literals(["complete", "partial"]),
  stale: Schema.Boolean,
  files: Schema.NullOr(Schema.Finite),
  additions: Schema.NullOr(Schema.Finite),
  deletions: Schema.NullOr(Schema.Finite),
  uncommitted: Schema.NullOr(Schema.Finite),
  binary: Schema.NullOr(Schema.Finite),
  conflicts: Schema.NullOr(Schema.Finite),
  lineStatsComplete: Schema.Boolean,
}).annotate({ identifier: "VcsWorkSummary" })
export type WorkSummary = typeof WorkSummary.Type

export class ReadError extends Schema.TaggedErrorClass<ReadError>()("VcsReadError", {
  reason: Schema.Literals(["read_failed", "ref_invalid", "no_common_ancestor", "scope_changed"]),
}) {}

const valid = (result: Git.Result) => result.exitCode === 0 && !result.truncated
const oid = (result: Git.Result) =>
  valid(result) && /^[a-f0-9]{40,64}$/.test(result.text().trim()) ? result.text().trim() : null

/** Local cached refs only. Symbolic remote HEAD aliases are not comparison choices. */
export const refs = Effect.fn("VcsOverview.refs")(function* (
  git: Git.Interface,
  directory: string,
  deadline = Date.now() + limits.milliseconds,
) {
  const timeout = () => Duration.millis(Math.max(1, deadline - Date.now()))
  const [root, result] = yield* Effect.all(
    [
      git.run(["rev-parse", "--show-toplevel"], { cwd: directory, timeout: timeout(), maxOutputBytes: limits.bytes }),
      git.run(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)", "refs/heads", "refs/remotes"], {
        cwd: directory,
        timeout: timeout(),
        maxOutputBytes: limits.bytes,
      }),
    ],
    { concurrency: 2 },
  )
  if (!valid(root) || !valid(result)) return yield* new ReadError({ reason: "read_failed" })
  const items = result
    .text()
    .split("\n")
    .filter(Boolean)
    .flatMap<Ref>((line) => {
      const [ref, value, symbolic] = line.split("\0")
      if (!ref || symbolic || !/^[a-f0-9]{40,64}$/.test(value ?? "")) return []
      if (ref.startsWith("refs/heads/")) return [{ name: ref.slice(11), ref, oid: value!, kind: "local" as const }]
      if (ref.startsWith("refs/remotes/")) return [{ name: ref.slice(13), ref, oid: value!, kind: "remote" as const }]
      return []
    })
  return {
    directory,
    repositoryRoot: root.text().replace(/\r?\n$/, "") || null,
    observedAt: Date.now(),
    items: items.slice(0, limits.refs),
    truncated: items.length > limits.refs,
  }
})

/** Resolve only an enumerated branch; never accept revision expressions or shell input. */
export const base = Effect.fn("VcsOverview.base")(function* (
  git: Git.Interface,
  directory: string,
  name: string,
  deadline = Date.now() + limits.milliseconds,
) {
  const list = yield* refs(git, directory, deadline)
  const selected = list.items.find((item) => item.ref === name) ?? list.items.find((item) => item.name === name)
  if (!selected) return yield* new ReadError({ reason: "ref_invalid" })
  const result = yield* git.run(["rev-parse", "--verify", "--end-of-options", `${selected.ref}^{commit}`], {
    cwd: directory,
    timeout: Duration.millis(Math.max(1, deadline - Date.now())),
    maxOutputBytes: 1024,
  })
  const value = oid(result)
  if (!value || value !== selected.oid) return yield* new ReadError({ reason: "scope_changed" })
  return { ref: selected.ref, oid: value }
})

const stats = (text: string, path?: string) =>
  (path ? text.split("\0")[0]! : text)
    .split("\0")
    .filter(Boolean)
    .flatMap((line) => {
      const first = line.indexOf("\t")
      const second = line.indexOf("\t", first + 1)
      if (first < 0 || second < 0) return []
      const additions = line.slice(0, first)
      const deletions = line.slice(first + 1, second)
      const file = path ?? line.slice(second + 1)
      if (!file) return []
      if (additions === "-" || deletions === "-") return [{ file, additions: 0, deletions: 0, binary: true }]
      if (!/^\d+$/.test(additions) || !/^\d+$/.test(deletions)) return []
      return [{ file, additions: Number(additions), deletions: Number(deletions), binary: false }]
    })

export const summary = Effect.fn("VcsOverview.summary")(function* (
  git: Git.Interface,
  input: { directory: string; git: boolean; baseRef?: string; defaultRef?: string },
) {
  const startedAt = Date.now()
  const output: WorkSummary = {
    directory: input.directory,
    repositoryRoot: null,
    branch: null,
    headOID: null,
    baseRef: input.baseRef ?? null,
    baseOID: null,
    mergeBaseOID: null,
    startedAt,
    observedAt: startedAt,
    state: input.git ? "unavailable" : "non_git",
    coverage: "partial",
    stale: false,
    files: null,
    additions: null,
    deletions: null,
    uncommitted: null,
    binary: null,
    conflicts: null,
    lineStatsComplete: false,
  }
  if (!input.git) return output
  const run = (args: string[]) =>
    git.run(args, {
      cwd: input.directory,
      timeout: Duration.millis(Math.max(1, startedAt + limits.milliseconds - Date.now())),
      maxOutputBytes: limits.bytes,
      maxErrorBytes: 1024,
    })
  const [root, head, branch, before, prefix] = yield* Effect.all(
    [
      run(["rev-parse", "--show-toplevel"]),
      run(["rev-parse", "--verify", "HEAD^{commit}"]),
      run(["symbolic-ref", "--quiet", "--short", "HEAD"]),
      run([
        "-c",
        "status.relativePaths=true",
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--no-renames",
        "-z",
        "--",
        ".",
      ]),
      run(["rev-parse", "--show-prefix"]),
    ],
    { concurrency: 5 },
  )
  const identity = {
    ...output,
    repositoryRoot: valid(root) ? root.text().replace(/\r?\n$/, "") : null,
    headOID: oid(head),
    branch: valid(branch) ? branch.text().trim() || null : null,
  }
  if (!identity.repositoryRoot || !valid(before) || !valid(prefix)) return { ...identity, observedAt: Date.now() }
  if (!identity.headOID) return { ...identity, state: "unborn" as const, observedAt: Date.now() }
  const name = input.baseRef ?? input.defaultRef
  if (!name) return { ...identity, state: "base_unavailable" as const, observedAt: Date.now() }
  const selected = yield* base(git, input.directory, name, startedAt + limits.milliseconds).pipe(
    Effect.catch((error) => Effect.succeed({ error })),
  )
  if ("error" in selected)
    return {
      ...identity,
      state: selected.error.reason === "ref_invalid" ? ("base_unavailable" as const) : ("unavailable" as const),
      stale: selected.error.reason === "scope_changed",
      observedAt: Date.now(),
    }
  const ancestor = yield* run(["merge-base", selected.oid, identity.headOID])
  const comparison = { ...identity, baseRef: selected.ref, baseOID: selected.oid, mergeBaseOID: oid(ancestor) }
  if (!comparison.mergeBaseOID)
    return {
      ...comparison,
      state:
        ancestor.exitCode === 1 && !ancestor.truncated ? ("no_common_ancestor" as const) : ("unavailable" as const),
      observedAt: Date.now(),
    }
  const tracked = yield* run([
    "diff",
    "--numstat",
    "--relative",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "-z",
    comparison.mergeBaseOID,
    "--",
    ".",
  ])
  if (!valid(tracked)) return { ...comparison, observedAt: Date.now() }
  const directoryPrefix = prefix.text().replace(/\r?\n$/, "")
  const status = before
    .text()
    .split("\0")
    .filter(Boolean)
    .map((line) => ({
      code: line.slice(0, 2),
      file:
        directoryPrefix && line.slice(3).startsWith(directoryPrefix)
          ? line.slice(3 + directoryPrefix.length)
          : line.slice(3),
    }))
  const paths = new Map(stats(tracked.text()).map((item) => [item.file, item]))
  const untracked = status.filter((item) => item.code === "??")
  const fileCount = new Set([...paths.keys(), ...untracked.map((item) => item.file)]).size
  let partial = false
  for (const item of untracked) {
    if (paths.size >= limits.files || Date.now() >= startedAt + limits.milliseconds) {
      partial = true
      break
    }
    const result = yield* run([
      "diff",
      "--no-index",
      "--numstat",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "-z",
      "--",
      "/dev/null",
      item.file,
    ])
    if ((result.exitCode !== 0 && result.exitCode !== 1) || result.truncated) {
      partial = true
      continue
    }
    const value = stats(result.text(), item.file)[0]
    if (value) {
      paths.set(item.file, { ...value, file: item.file })
      continue
    }
    // Empty files and symlinks still count as changed files; missing line evidence remains explicit.
    paths.set(item.file, { file: item.file, additions: 0, deletions: 0, binary: result.exitCode !== 0 })
  }
  const [afterHead, afterBase, after] = yield* Effect.all(
    [
      run(["rev-parse", "--verify", "HEAD^{commit}"]),
      run(["rev-parse", "--verify", "--end-of-options", `${selected.ref}^{commit}`]),
      run([
        "-c",
        "status.relativePaths=true",
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--no-renames",
        "-z",
        "--",
        ".",
      ]),
    ],
    { concurrency: 3 },
  )
  const changed =
    oid(afterHead) !== comparison.headOID ||
    oid(afterBase) !== comparison.baseOID ||
    !valid(after) ||
    before.text() !== after.text()
  const values = [...paths.values()]
  return {
    ...comparison,
    state: "ready" as const,
    observedAt: Date.now(),
    stale: changed,
    coverage: partial || paths.size > limits.files ? ("partial" as const) : ("complete" as const),
    files: fileCount,
    additions: values.reduce((sum, item) => sum + item.additions, 0),
    deletions: values.reduce((sum, item) => sum + item.deletions, 0),
    uncommitted: new Set(status.map((item) => item.file)).size,
    binary: values.filter((item) => item.binary).length,
    conflicts: status.filter((item) => item.code.includes("U") || item.code === "AA" || item.code === "DD").length,
    lineStatsComplete: !partial && values.every((item) => !item.binary),
  } satisfies WorkSummary
})
