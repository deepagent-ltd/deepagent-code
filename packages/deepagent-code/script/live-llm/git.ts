import { minimatch } from "minimatch"
import { modelRunKey, selectRoutes } from "./routes"

const objectID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

export type PushedRef = {
  localRef: string
  localOID: string
  remoteRef: string
  remoteOID: string
}

export type ResolvedPushedRef = PushedRef & {
  kind: "commit" | "delete" | "non-commit-tag"
  commitOID?: string
  remoteCommitOID?: string
  paths: string[]
}

export function parsePushedRefs(input: string) {
  return input
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      const fields = line.trim().split(/\s+/)
      if (fields.length !== 4) throw new Error(`Invalid pre-push input on line ${index + 1}: expected four fields`)
      if (!objectID.test(fields[1]) || !objectID.test(fields[3])) {
        throw new Error(`Invalid pre-push input on line ${index + 1}: expected SHA-1 or SHA-256 object IDs`)
      }
      if (!fields[2].startsWith("refs/")) {
        throw new Error(`Invalid pre-push input on line ${index + 1}: expected a full remote ref name`)
      }
      if (!fields[0].startsWith("refs/") && fields[0] !== "HEAD" && fields[0] !== "(delete)") {
        throw new Error(`Invalid pre-push input on line ${index + 1}: invalid local ref name`)
      }
      if ((fields[0] === "(delete)") !== /^0+$/.test(fields[1])) {
        throw new Error(`Invalid pre-push input on line ${index + 1}: inconsistent deletion fields`)
      }
      return {
        localRef: fields[0],
        localOID: fields[1].toLowerCase(),
        remoteRef: fields[2],
        remoteOID: fields[3].toLowerCase(),
      }
    })
}

export async function resolvePushedRefs(input: { repository: string; remote: string; refs: PushedRef[] }) {
  const refs = await Promise.all(
    input.refs.map(async (ref): Promise<ResolvedPushedRef> => {
      if (isZeroOID(ref.localOID)) return { ...ref, kind: "delete", paths: [] }

      const commitOID = await peelCommit(input.repository, ref.localOID)
      if (!commitOID) {
        if (ref.localRef.startsWith("refs/tags/")) return { ...ref, kind: "non-commit-tag", paths: [] }
        throw new Error(`Cannot peel pushed branch ${ref.localRef} object ${ref.localOID} to a commit`)
      }

      const remoteCommitOID = isZeroOID(ref.remoteOID) ? undefined : await peelCommit(input.repository, ref.remoteOID)
      if (!isZeroOID(ref.remoteOID) && !remoteCommitOID && !ref.remoteRef.startsWith("refs/tags/")) {
        throw new Error(`Cannot peel remote branch ${ref.remoteRef} object ${ref.remoteOID} to a commit`)
      }

      const paths = remoteCommitOID
        ? await changedPaths(input.repository, remoteCommitOID, commitOID)
        : await newRefPaths(input.repository, input.remote, commitOID)
      return {
        ...ref,
        kind: "commit",
        commitOID,
        remoteCommitOID,
        paths,
      }
    }),
  )

  const commits = [
    ...new Set(
      refs
        .filter((ref): ref is ResolvedPushedRef & { kind: "commit"; commitOID: string } => ref.kind === "commit")
        .map((ref) => ref.commitOID),
    ),
  ]
  const paths = [...new Set(refs.flatMap((ref) => ref.paths))].sort()

  return {
    refs,
    commits,
    paths,
    selection: selectRoutes(paths),
  }
}

export async function readDirtyPaths(repository: string) {
  return parseDirtyPaths((await git(repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout)
}

export function parseDirtyPaths(output: string) {
  const records = output.split("\0")
  const paths = new Set<string>()

  for (let index = 0; index < records.length; index++) {
    if (!records[index]) continue
    if (records[index].length < 4 || records[index][2] !== " ") {
      throw new Error("Invalid git status --porcelain=v1 -z output")
    }
    const status = records[index].slice(0, 2)
    paths.add(records[index].slice(3))
    if (!/[RC]/.test(status)) continue
    index++
    if (!records[index]) throw new Error("Invalid rename entry in git status output")
    paths.add(records[index])
  }

  return [...paths].sort()
}

export function blockingDirtyPaths(selection: ReturnType<typeof selectRoutes>, dirtyPaths: Iterable<string>) {
  const checks = new Set(selection.checks)
  const runs = new Set(selection.runs.map(modelRunKey))
  const harnessPaths = [
    "packages/llm/script/live-llm/**",
    "packages/core/script/live-llm/**",
    "packages/deepagent-code/script/live-llm/**",
    "packages/deepagent-code/test/script/live-llm-routes.test.ts",
    "packages/desktop/scripts/live-llm/**",
    "script/pre-push-live-llm.ts",
  ]

  return [...dirtyPaths]
    .filter((path) => {
      if (harnessPaths.some((pattern) => minimatch(path, pattern))) return true
      const dirty = selectRoutes([path])
      if (dirty.invalid.length || dirty.unclassified.length) return true
      if (dirty.checks.some((check) => checks.has(check))) return true
      return dirty.runs.some((run) => runs.has(modelRunKey(run)))
    })
    .sort()
}

async function newRefPaths(repository: string, remote: string, commitOID: string) {
  if (!remote || remote.startsWith("-")) throw new Error(`Invalid remote name: ${remote}`)
  const commits = splitLines((await git(repository, ["rev-list", commitOID, "--not", `--remotes=${remote}`])).stdout)
  return [
    ...new Set(
      (
        await Promise.all(
          commits.map(async (commit) =>
            splitZero(
              (
                await git(repository, [
                  "diff-tree",
                  "--root",
                  "--no-commit-id",
                  "--name-only",
                  "--no-renames",
                  "-r",
                  "-z",
                  commit,
                ])
              ).stdout,
            ),
          ),
        )
      ).flat(),
    ),
  ].sort()
}

async function changedPaths(repository: string, remoteCommitOID: string, commitOID: string) {
  return splitZero(
    (await git(repository, ["diff", "--name-only", "--no-renames", "-z", remoteCommitOID, commitOID])).stdout,
  ).sort()
}

async function peelCommit(repository: string, oid: string) {
  const result = await git(repository, ["rev-parse", "--verify", `${oid}^{commit}`], true)
  if (!result.success) return
  return result.stdout.trim()
}

async function git(repository: string, args: string[], allowFailure = false) {
  const process = Bun.spawn(["git", ...args], {
    cwd: repository,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0 && !allowFailure) {
    throw new Error(`git ${args[0]} failed (${exitCode}): ${stderr.trim() || "no stderr"}`)
  }
  return { stdout, stderr, exitCode, success: exitCode === 0 }
}

function isZeroOID(oid: string) {
  return /^0+$/.test(oid)
}

function splitZero(value: string) {
  return value.split("\0").filter(Boolean)
}

function splitLines(value: string) {
  return value.split(/\r?\n/).filter(Boolean)
}
