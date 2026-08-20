#!/usr/bin/env bun
/**
 * QUAL-003 gate: forbid test fixtures from bypassing the durable session state machine.
 *
 * Tests must drive authority tables through the lifecycle helpers
 * (admission -> preparing -> prepared -> dispatching -> terminal). Direct
 * `db.insert(...)` calls against the authority tables below bypass the state
 * machine and cascade-break fixtures whenever the schema tightens.
 *
 * oxlint has no call-combination rule for this, so this grep-style CI gate
 * scans test sources under every package (`packages/<pkg>/test`, ts and tsx)
 * and fails on every direct insert.
 *
 * Exemptions: a line ending with `// fixture-exempt: <reason>` is skipped.
 * Only legacy crash-recovery fixtures that intentionally seed abnormal states
 * may carry an exemption; new tests must use lifecycle helpers instead.
 *
 * Usage:
 *   bun script/check-test-fixtures.ts              # fail on any non-exempt hit
 *   bun script/check-test-fixtures.ts --baseline N # pass while hits <= N (ratchet mode)
 */

import * as fs from "node:fs"
import * as path from "node:path"

const AUTHORITY_TABLES = [
  "SessionActivityTable",
  "SessionProviderAttemptTable",
  "SessionToolRequestReceiptTable",
  "SessionActivityAdmissionTable",
] as const

/**
 * Ratchet baseline for legacy bypassing fixtures. The current legacy inventory
 * is fully annotated with `// fixture-exempt:` comments, so the strict mode
 * baseline is zero. If the inventory ever grows unmanageably large, bump this
 * and run with --baseline to switch to report-only-for-new-violations mode.
 */
const DEFAULT_BASELINE = 0

const EXEMPTION_PATTERN = /\/\/\s*fixture-exempt:\s*\S/
const INSERT_PATTERN = new RegExp(String.raw`\.insert\s*\(\s*(${AUTHORITY_TABLES.join("|")})\b`, "g")

interface Violation {
  readonly file: string
  readonly line: number
  readonly table: string
}

function* walkTestFiles(root: string): Generator<string> {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".artifacts") continue
      yield* walkTestFiles(full)
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      yield full
    }
  }
}

function lineOfIndex(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1
  }
  return line
}

function lineText(content: string, line: number): string {
  return content.split("\n")[line - 1] ?? ""
}

function scan(root: string): Violation[] {
  const violations: Violation[] = []
  const packagesDir = path.join(root, "packages")
  let packages: string[] = []
  try {
    packages = fs
      .readdirSync(packagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(packagesDir, entry.name, "test"))
  } catch {
    packages = []
  }
  for (const testDir of packages) {
    for (const file of walkTestFiles(testDir)) {
      const content = fs.readFileSync(file, "utf8")
      for (const match of content.matchAll(INSERT_PATTERN)) {
        const line = lineOfIndex(content, match.index ?? 0)
        const table = match[1] ?? "unknown"
        if (EXEMPTION_PATTERN.test(lineText(content, line))) continue
        violations.push({
          file: path.relative(root, file),
          line,
          table,
        })
      }
    }
  }
  return violations.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)))
}

function main(): void {
  const repoRoot = path.resolve(import.meta.dir, "..")
  const args = process.argv.slice(2)
  let baseline: number | null = null
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--baseline") {
      const raw = args[i + 1]
      const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10)
      if (Number.isNaN(parsed) || parsed < 0) {
        console.error(`check-test-fixtures: invalid --baseline value: ${raw ?? "<missing>"}`)
        process.exit(2)
      }
      baseline = parsed
      i += 1
    } else {
      console.error(`check-test-fixtures: unknown argument: ${args[i]}`)
      process.exit(2)
    }
  }
  const effectiveBaseline = baseline ?? DEFAULT_BASELINE

  const violations = scan(repoRoot)
  console.log(
    `check-test-fixtures: scanned packages/*/test/**/*.{ts,tsx} for direct inserts into ${AUTHORITY_TABLES.join(", ")}`,
  )

  if (violations.length === 0) {
    console.log("check-test-fixtures: no non-exempt fixture bypasses found")
    return
  }

  for (const violation of violations) {
    console.log(
      `${violation.file}:${violation.line}: direct .insert(${violation.table}) bypasses the durable state machine`,
    )
  }

  if (baseline !== null && violations.length <= effectiveBaseline) {
    console.log(
      `check-test-fixtures: ${violations.length} hit(s) within baseline ${effectiveBaseline}; ratchet down over time`,
    )
    return
  }

  console.error(
    [
      "",
      `check-test-fixtures: ${violations.length} violation(s). Test fixtures must not insert`,
      "authority rows directly; drive them through the durable lifecycle helpers",
      "(admission -> preparing -> prepared -> dispatching -> terminal).",
      "Legacy crash-recovery fixtures may be annotated with a trailing",
      "`// fixture-exempt: <reason>` comment on the matched line.",
    ].join("\n"),
  )
  process.exit(1)
}

main()
