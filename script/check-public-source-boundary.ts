import { resolve } from "node:path"

const policy = (await Bun.file(resolve(".github/public-source-policy.json")).json()) as {
  version: number
  public_document_paths: string[]
  private_document_paths: string[]
}

if (
  policy.version !== 2 ||
  !Array.isArray(policy.public_document_paths) ||
  !Array.isArray(policy.private_document_paths) ||
  [...policy.public_document_paths, ...policy.private_document_paths].some((path) => typeof path !== "string" || !path)
)
  throw new Error("Invalid public source policy")

// Public DAC documentation can evolve independently of the upstream text.
// New document paths require review; internal archives remain private regardless of approval.
const publicDocuments = new Set(policy.public_document_paths)
const privateDocuments = new Set(policy.private_document_paths)

const flags = new Set(process.argv.slice(2))
if ([...flags].some((flag) => flag !== "--worktree" && flag !== "--history"))
  throw new Error("Usage: bun script/check-public-source-boundary.ts [--worktree] [--history]")

const violations = new Set<string>()
const checked = new Set<string>()
const tree = git(["ls-tree", "-rz", "HEAD"]).split("\0")

tree.filter(Boolean).forEach((record) => {
  const separator = record.indexOf("\t")
  const blob = record.slice(0, separator).split(" ")[2]
  if (separator < 0 || !blob) throw new Error("Unexpected Git tree record")
  check(record.slice(separator + 1), blob)
})

if (flags.has("--worktree")) {
  const paths = new Set(git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean))
  await Promise.all(
    [...paths].map(async (path) => {
      const file = Bun.file(path)
      if (!(await file.exists())) return
      if (!/\.(md|mdx|markdown)$/i.test(path) && !forbidden(path)) return
      check(path, "worktree")
    }),
  )
}

if (flags.has("--history")) {
  if (git(["rev-parse", "--is-shallow-repository"]).trim() !== "false")
    throw new Error("History verification requires a complete checkout (fetch-depth: 0)")
  const records = git(["log", "--root", "-m", "--no-renames", "--format=", "--raw", "-z", "--no-abbrev", "HEAD"]).split("\0")
  records.forEach((record, index) => {
    const fields = record.trimStart().split(" ")
    if (!fields[0]?.startsWith(":")) return
    const blob = fields[3]
    const path = records[index + 1]
    if (fields.length !== 5 || !blob || path === undefined) throw new Error("Unexpected Git history record")
    if (/^0+$/.test(blob)) return
    check(path, blob)
  })
}

if (violations.size) {
  console.error(JSON.stringify({ status: "rejected", paths: [...violations].sort() }, null, 2))
  process.exit(1)
}

console.log(JSON.stringify({ status: "passed", checked: checked.size, worktree: flags.has("--worktree"), history: flags.has("--history") }))

function check(path: string, blob: string) {
  const key = `${path}\0${blob}`
  if (checked.has(key)) return
  checked.add(key)
  if (forbidden(path)) {
    violations.add(path)
    return
  }
  if (!/\.(md|mdx|markdown)$/i.test(path)) return
  if (publicDocuments.has(path)) return
  violations.add(path)
}

function forbidden(path: string) {
  return /^(docs|release|\.artifacts|release-evidence|gui-test-screenshots|specs\/v2)(\/|$)/i.test(path) || privateDocuments.has(path)
}

function git(args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || `Git failed: ${args[0]}`)
  return result.stdout.toString()
}
