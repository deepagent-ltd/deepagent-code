#!/usr/bin/env bun
import { parseArgs } from "node:util"
import path from "node:path"

// Environment-sensitive tests run on real local hardware, not hosted runners.
// CI keeps the logic and integration suites; see the manifest header and
// docs/v2.0.5-closeout-remediation-20261103.md.
const repository = path.resolve(import.meta.dir, "..")
const manifest = (await Bun.file(path.join(import.meta.dir, "ci-stability-manifest.json")).json()) as Manifest

const { values } = parseArgs({
  options: {
    platform: { type: "string" },
    package: { type: "string", multiple: true },
    file: { type: "string", multiple: true },
    timeout: { type: "string" },
    "file-timeout": { type: "string" },
    parallel: { type: "string" },
    list: { type: "boolean" },
    validate: { type: "boolean" },
    "print-ignore-patterns": { type: "boolean" },
    "dry-run": { type: "boolean" },
    help: { type: "boolean" },
  },
  strict: true,
})

if (values.help) {
  console.log(`Usage: bun script/run-ci-stability.ts [options]

Runs the environment-sensitive test files listed in script/ci-stability-manifest.json
on the current machine with generous per-test and per-file budgets.

  --platform <win32|darwin|linux>  Select entries for another platform
  --package <directory>            Only entries in this package (repeatable)
  --file <package-relative path>   Only this file (repeatable)
  --timeout <ms>                   Per-test budget (default 300000)
  --file-timeout <ms>              Per-file wall clock cap (default 1200000)
  --parallel <n>                   Files to run concurrently (default 1)
  --list                           Print the selected entries
  --validate                       Check the manifest against the checkout
  --print-ignore-patterns          Print Bun --path-ignore-patterns values
  --dry-run                        Print the commands without running them`)
  process.exit(0)
}

if (values.validate) {
  const problems = await validate()
  for (const problem of problems) console.error(problem)
  console.log(problems.length ? `Invalid manifest: ${problems.length} problem(s)` : `Manifest is valid: ${manifest.entries.length} entries`)
  process.exit(problems.length ? 1 : 0)
}

const platform = values.platform ?? process.platform
const selected = manifest.entries.filter((entry) =>
  entry.platforms.includes(platform) &&
  (!values.package?.length || values.package.includes(entry.package)) &&
  (!values.file?.length || values.file.includes(entry.file)))

if (values.list) {
  for (const entry of selected) console.log(`${entry.package}/${entry.file} [${entry.platforms.join(",")}] ${entry.reason}`)
  console.log(`${selected.length} entries for ${platform}`)
  process.exit(0)
}

if (values["print-ignore-patterns"]) {
  for (const entry of selected) console.log(`**/${entry.file}`)
  process.exit(0)
}

if (!selected.length) {
  console.error(`No CI stability entries match platform=${platform}`)
  process.exit(1)
}

const timeout = positive(values.timeout ?? "300000", "--timeout")
const fileTimeout = positive(values["file-timeout"] ?? "1200000", "--file-timeout")
const parallel = positive(values.parallel ?? "1", "--parallel")
const queue = [...selected]
const failures: string[] = []
const startedAt = Date.now()
let completed = 0

await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, async () => {
  while (queue.length) {
    const entry = queue.shift()!
    const directory = path.join(repository, entry.package)
    const command = [process.execPath, "test", "--isolate", `--timeout=${timeout}`, `./${entry.file}`]
    if (values["dry-run"]) {
      console.log(`cd ${directory} && ${command.join(" ")}`)
      continue
    }
    const child = Bun.spawn({
      cmd: command,
      cwd: directory,
      env: { ...process.env, DAC_CI_STABILITY: "1" },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    })
    const fileStarted = Date.now()
    const timer = setTimeout(() => child.kill("SIGKILL"), fileTimeout)
    const code = await child.exited
    clearTimeout(timer)
    const seconds = ((Date.now() - fileStarted) / 1000).toFixed(1)
    completed += 1
    if (code === 0) {
      console.log(`ok   [${completed}/${selected.length}] ${entry.package}/${entry.file} (${seconds}s)`)
      continue
    }
    const detail = code === 137 && seconds === (fileTimeout / 1000).toFixed(1) ? "file budget" : `exit ${code}`
    console.log(`FAIL [${completed}/${selected.length}] ${entry.package}/${entry.file} (${seconds}s, ${detail})`)
    failures.push(`${entry.package}/${entry.file} (${detail})`)
  }
}))

if (values["dry-run"]) process.exit(0)

const total = ((Date.now() - startedAt) / 1000).toFixed(0)
console.log(`\n${selected.length} files, ${selected.length - failures.length} passed, ${failures.length} failed, ${total}s`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(failures.length ? 1 : 0)

async function validate() {
  const problems: string[] = []
  const ids = new Set<string>()
  for (const entry of manifest.entries) {
    const id = `${entry.package}/${entry.file}`
    if (ids.has(id)) problems.push(`duplicate entry: ${id}`)
    ids.add(id)
    if (!entry.platforms.length) problems.push(`missing platform: ${id}`)
    if (!entry.reason) problems.push(`missing reason: ${id}`)
    const inside = path.relative(path.join(repository, entry.package), path.join(repository, entry.package, entry.file))
    if (inside.startsWith("..") || path.isAbsolute(inside)) problems.push(`escapes package: ${id}`)
    if (!(await Bun.file(path.join(repository, id)).exists())) problems.push(`missing file: ${id}`)
  }
  const tracked = Bun.spawnSync(["git", "ls-files", "--", ...ids], { cwd: repository, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  if (tracked.exitCode !== 0) {
    problems.push(`git ls-files failed: ${tracked.stderr.toString().trim()}`)
    return problems
  }
  const trackedIds = new Set(tracked.stdout.toString().split("\n").filter(Boolean))
  for (const id of ids) if (!trackedIds.has(id)) problems.push(`untracked file: ${id}`)
  return problems
}

function positive(value: string, flag: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive integer`)
  return parsed
}

type Manifest = {
  entries: {
    package: string
    file: string
    platforms: string[]
    reason: string
  }[]
}
