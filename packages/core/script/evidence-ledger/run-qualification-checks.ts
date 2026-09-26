#!/usr/bin/env bun
// Capture real candidate-tree static checks as raw evidence. The results never decide G0-G8.
import path from "node:path"

const args = process.argv.slice(2)
const option = (name: string) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined)
const out = option("--out")
const commit = option("--commit")
const tree = option("--tree")
if (!out || !commit || !tree) throw new Error("usage: run-qualification-checks.ts --out FILE --commit SHA --tree SHA")
const repository = path.resolve(import.meta.dir, "../../../..")
const git = (...spec: string[]) => {
  const result = Bun.spawnSync(["git", ...spec], { cwd: repository, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}
if (git("rev-parse", "HEAD") !== commit || git("rev-parse", "HEAD^{tree}") !== tree)
  throw new Error("qualification checks candidate identity mismatch")
if (git("status", "--porcelain", "--untracked-files=all"))
  throw new Error("qualification checks require a clean candidate tree")
const run = async (command: string[], cwd: string) => {
  const startedAt = new Date().toISOString()
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return {
    command: command.join(" "),
    cwd: path.relative(repository, cwd) || ".",
    startedAt,
    completedAt: new Date().toISOString(),
    exitCode,
    stdout,
    stderr,
  }
}
const packages = (await Array.fromAsync(new Bun.Glob("packages/*/package.json").scan({ cwd: repository }))).toSorted()
const typechecks = await Promise.all(
  packages.map(async (file) => ({
    file,
    package: (await Bun.file(path.join(repository, file)).json()) as { scripts?: { typecheck?: string } },
  })),
)
const commands = [
  { command: ["git", "diff", "--check", "HEAD^", "HEAD"], cwd: repository },
  { command: ["bun", "script/check-test-fixtures.ts"], cwd: repository },
  { command: ["bun", "run", "manifest:assert-reproducible"], cwd: path.join(repository, "packages/core") },
  ...typechecks
    .filter((entry) => entry.package.scripts?.typecheck)
    .map((entry) => ({
      command: ["bun", "typecheck"],
      cwd: path.join(repository, path.dirname(entry.file)),
    })),
]
const checks = []
for (const entry of commands) checks.push(await run(entry.command, entry.cwd))
await Bun.write(out, `${JSON.stringify({ candidateCommit: commit, candidateTree: tree, checks }, null, 2)}\n`)
if (checks.some((check) => check.exitCode !== 0)) throw new Error("qualification static checks failed; see raw evidence")
