#!/usr/bin/env bun
/**
 * BUG-407-005 release-evidence tooling: archive immutable gate manifests and
 * verify them against tampering.
 *
 * Layout (see release-evidence/README.md):
 *   release-evidence/<version>/<commit>/<gate-id>/manifest.json
 *
 * Manifests are immutable. This tool never overwrites an existing manifest:
 * re-running archive for the same version/commit/gate fails. Corrections or
 * retries must create a new gate attempt (a new gate id) instead.
 *
 * Usage:
 *   # Generate a gate manifest (fails if it already exists)
 *   bun script/release-evidence.ts archive \
 *     --gate release-gate-20260819 \
 *     [--commit <sha>]            # default: git rev-parse HEAD
 *     [--version v4.1]            # release line, default v4.1
 *     [--date YYYY-MM-DD]         # gate date, default today (UTC)
 *     [--status passed]           # passed|failed|blocked|not_run
 *     [--summary "<text>"] \
 *     [--evidence <kind>:<label>[:<path>]]...   # repeatable
 *     [--conclusion <label>=<text>]...          # repeatable
 *     [--sign <role>=<actor>]...                # repeatable
 *     [--root <dir>]              # repo root, default: this script's parent
 *
 *   # Verify an existing manifest: file hashes match, nothing tampered
 *   bun script/release-evidence.ts check --gate <gate-id> [--commit <sha>] [--version v4.1] [--root <dir>]
 *   bun script/release-evidence.ts check <path/to/manifest.json>
 */

import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

export const RELEASE_EVIDENCE_SCHEMA_VERSION = "deepagent.release_evidence.v1"
export const EVIDENCE_DIRNAME = "release-evidence"
export const MANIFEST_FILENAME = "manifest.json"

export const EVIDENCE_KINDS = [
  "test-summary",
  "migration",
  "smoke",
  "live",
  "capacity",
  "log",
  "db",
  "request",
  "ui",
  "receipt",
  "metric",
] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

export const GATE_STATUSES = ["passed", "failed", "blocked", "not_run"] as const
export type GateStatus = (typeof GATE_STATUSES)[number]

export interface EvidenceEntry {
  readonly kind: EvidenceKind
  readonly label: string
  readonly path: string | null
  readonly sha256: string | null
  readonly conclusion: string
}

export interface SignatureEntry {
  readonly role: string
  readonly actor: string
  readonly at: string
}

export interface ReleaseEvidenceManifest {
  readonly schema_version: typeof RELEASE_EVIDENCE_SCHEMA_VERSION
  readonly version: string
  readonly gate_id: string
  readonly commit: string
  readonly date: string
  readonly generated_at: string
  readonly status: GateStatus
  readonly summary?: string
  readonly evidence: readonly EvidenceEntry[]
  readonly signatures: readonly SignatureEntry[]
}

export interface ArchiveOptions {
  readonly root: string
  readonly version: string
  readonly gateID: string
  readonly commit: string
  readonly date: string
  readonly generatedAt: string
  readonly status: GateStatus
  readonly summary?: string
  readonly evidence: readonly EvidenceEntry[]
  readonly signatures: readonly SignatureEntry[]
}

export interface CheckResult {
  readonly ok: boolean
  readonly manifestPath: string
  readonly failures: readonly string[]
}

const GATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const VERSION_PATTERN = /^v[0-9]+\.[0-9]+$/
const DATE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/

export class ReleaseEvidenceError extends Error {}

export function sha256Hex(buffer: Uint8Array | string): string {
  return createHash("sha256").update(buffer).digest("hex")
}

export function sha256OfFile(filePath: string): string {
  return sha256Hex(fs.readFileSync(filePath))
}

export function manifestPathFor(root: string, version: string, commit: string, gateID: string): string {
  return path.join(root, EVIDENCE_DIRNAME, version, commit, gateID, MANIFEST_FILENAME)
}

/** Deterministic serialization: fixed key order, 2-space indent, trailing newline. */
export function serializeManifest(manifest: ReleaseEvidenceManifest): string {
  const body: Record<string, unknown> = {
    schema_version: manifest.schema_version,
    version: manifest.version,
    gate_id: manifest.gate_id,
    commit: manifest.commit,
    date: manifest.date,
    generated_at: manifest.generated_at,
    status: manifest.status,
  }
  if (manifest.summary !== undefined) body.summary = manifest.summary
  body.evidence = manifest.evidence.map((entry) => ({
    kind: entry.kind,
    label: entry.label,
    path: entry.path,
    sha256: entry.sha256,
    conclusion: entry.conclusion,
  }))
  body.signatures = manifest.signatures.map((signature) => ({
    role: signature.role,
    actor: signature.actor,
    at: signature.at,
  }))
  return `${JSON.stringify(body, null, 2)}\n`
}

export function buildManifest(options: ArchiveOptions): ReleaseEvidenceManifest {
  return {
    schema_version: RELEASE_EVIDENCE_SCHEMA_VERSION,
    version: options.version,
    gate_id: options.gateID,
    commit: options.commit,
    date: options.date,
    generated_at: options.generatedAt,
    status: options.status,
    summary: options.summary,
    evidence: options.evidence,
    signatures: options.signatures,
  }
}

/**
 * Write the gate manifest. Fails when the target already exists — manifests
 * are immutable and the tool offers no overwrite path.
 */
export function archiveGate(options: ArchiveOptions): string {
  validateArchiveOptions(options)
  const target = manifestPathFor(options.root, options.version, options.commit, options.gateID)
  if (fs.existsSync(target)) {
    throw new ReleaseEvidenceError(
      [
        `manifest already exists at ${path.relative(options.root, target)}`,
        "release-evidence manifests are immutable: no overwrite is offered.",
        "Record corrections or retries as a new gate attempt (new gate id).",
      ].join("\n"),
    )
  }
  const manifest = buildManifest(options)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, serializeManifest(manifest), { flag: "wx" })
  return target
}

/** Verify every file-backed evidence entry still matches its recorded SHA-256. */
export function checkManifest(manifestPath: string): CheckResult {
  const failures: string[] = []
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, manifestPath, failures: [`manifest not found: ${manifestPath}`] }
  }
  const root = resolveEvidenceRoot(path.dirname(manifestPath))
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  } catch (error) {
    return { ok: false, manifestPath, failures: [`manifest is not valid JSON: ${String(error)}`] }
  }
  if (!isRecord(parsed)) return { ok: false, manifestPath, failures: ["manifest root must be a JSON object"] }

  if (parsed.schema_version !== RELEASE_EVIDENCE_SCHEMA_VERSION) {
    failures.push(`unexpected schema_version: ${String(parsed.schema_version)}`)
  }
  for (const field of ["gate_id", "commit", "date", "status"] as const) {
    if (typeof parsed[field] !== "string" || parsed[field] === "") failures.push(`missing or empty field: ${field}`)
  }
  if (!Array.isArray(parsed.evidence)) {
    failures.push("missing evidence array")
    return { ok: false, manifestPath, failures }
  }

  const seenLabels = new Set<string>()
  for (const [index, raw] of parsed.evidence.entries()) {
    const where = `evidence[${index}]`
    if (!isRecord(raw)) {
      failures.push(`${where}: entry must be an object`)
      continue
    }
    const label = typeof raw.label === "string" ? raw.label : ""
    if (label === "") failures.push(`${where}: missing label`)
    else if (seenLabels.has(label)) failures.push(`${where}: duplicate label ${label}`)
    seenLabels.add(label)
    if (typeof raw.conclusion !== "string" || raw.conclusion === "") failures.push(`${where}: missing conclusion`)

    const entryPath = raw.path ?? null
    const recorded = raw.sha256 ?? null
    if ((entryPath === null) !== (recorded === null)) {
      failures.push(`${where}: path and sha256 must both be present or both be null`)
      continue
    }
    if (entryPath === null) continue
    if (typeof entryPath !== "string" || typeof recorded !== "string" || !SHA256_PATTERN.test(recorded)) {
      failures.push(`${where}: malformed path or sha256`)
      continue
    }
    const absolute = path.isAbsolute(entryPath) ? entryPath : path.join(root, entryPath)
    if (!fs.existsSync(absolute)) {
      failures.push(`${where} (${label || "?"}): file missing: ${entryPath}`)
      continue
    }
    const actual = sha256OfFile(absolute)
    if (actual !== recorded) {
      failures.push(`${where} (${label || "?"}): sha256 mismatch for ${entryPath}: recorded ${recorded}, actual ${actual}`)
    }
  }

  return { ok: failures.length === 0, manifestPath, failures }
}

/**
 * Locate gate manifests for a gate id. With a commit, the path is exact;
 * without one, every commit directory under the version line is searched.
 */
export function findManifestPaths(root: string, version: string, gateID: string, commit?: string): string[] {
  if (commit !== undefined) {
    const candidate = manifestPathFor(root, version, commit, gateID)
    return fs.existsSync(candidate) ? [candidate] : []
  }
  const versionDir = path.join(root, EVIDENCE_DIRNAME, version)
  let commits: string[] = []
  try {
    commits = fs
      .readdirSync(versionDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
  const found: string[] = []
  for (const commitDir of commits.sort()) {
    const candidate = path.join(versionDir, commitDir, gateID, MANIFEST_FILENAME)
    if (fs.existsSync(candidate)) found.push(candidate)
  }
  return found
}

export function resolveEvidenceRoot(startDir: string): string {
  let dir = path.resolve(startDir)
  for (;;) {
    if (fs.existsSync(path.join(dir, EVIDENCE_DIRNAME))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return path.resolve(startDir)
    dir = parent
  }
}

function validateArchiveOptions(options: ArchiveOptions): void {
  if (!VERSION_PATTERN.test(options.version)) throw new ReleaseEvidenceError(`invalid --version: ${options.version}`)
  if (!GATE_ID_PATTERN.test(options.gateID)) throw new ReleaseEvidenceError(`invalid --gate: ${options.gateID}`)
  if (!COMMIT_PATTERN.test(options.commit)) {
    throw new ReleaseEvidenceError(`invalid --commit (need full 40-char lowercase sha): ${options.commit}`)
  }
  if (!DATE_PATTERN.test(options.date)) throw new ReleaseEvidenceError(`invalid --date: ${options.date}`)
  if (!GATE_STATUSES.includes(options.status)) throw new ReleaseEvidenceError(`invalid --status: ${options.status}`)
  const labels = new Set<string>()
  for (const entry of options.evidence) {
    if (!EVIDENCE_KINDS.includes(entry.kind)) throw new ReleaseEvidenceError(`invalid evidence kind: ${entry.kind}`)
    if (!LABEL_PATTERN.test(entry.label)) throw new ReleaseEvidenceError(`invalid evidence label: ${entry.label}`)
    if (labels.has(entry.label)) throw new ReleaseEvidenceError(`duplicate evidence label: ${entry.label}`)
    labels.add(entry.label)
    if (entry.conclusion === "") throw new ReleaseEvidenceError(`evidence ${entry.label}: conclusion is required`)
    if ((entry.path === null) !== (entry.sha256 === null)) {
      throw new ReleaseEvidenceError(`evidence ${entry.label}: path and sha256 must both be present or both be null`)
    }
  }
}

interface CliOptions {
  root: string
  version: string
  gateID?: string
  commit?: string
  date?: string
  status: GateStatus
  summary?: string
  generatedAtForTest?: string
  evidenceSpecs: string[]
  conclusions: Map<string, string>
  signs: SignatureEntry[]
}

function parseCliArgs(argv: string[]): { command: "archive" | "check"; positional: string[]; options: CliOptions } {
  const [command, ...rest] = argv
  if (command !== "archive" && command !== "check") {
    throw new ReleaseEvidenceError(`unknown command: ${command ?? "<missing>"} (expected archive or check)`)
  }
  const options: CliOptions = {
    root: path.resolve(import.meta.dir, ".."),
    version: "v4.1",
    status: "passed",
    evidenceSpecs: [],
    conclusions: new Map(),
    signs: [],
  }
  const positional: string[] = []
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!
    const value = () => {
      const next = rest[i + 1]
      if (next === undefined) throw new ReleaseEvidenceError(`missing value for ${arg}`)
      i += 1
      return next
    }
    switch (arg) {
      case "--root":
        options.root = path.resolve(value())
        break
      case "--version":
        options.version = value()
        break
      case "--gate":
        options.gateID = value()
        break
      case "--commit":
        options.commit = value()
        break
      case "--date":
        options.date = value()
        break
      case "--status": {
        const raw = value()
        if (!GATE_STATUSES.includes(raw as GateStatus)) throw new ReleaseEvidenceError(`invalid --status: ${raw}`)
        options.status = raw as GateStatus
        break
      }
      case "--summary":
        options.summary = value()
        break
      case "--generated-at":
        options.generatedAtForTest = value()
        break
      case "--evidence":
        options.evidenceSpecs.push(value())
        break
      case "--conclusion": {
        const raw = value()
        const separator = raw.indexOf("=")
        if (separator <= 0) throw new ReleaseEvidenceError(`--conclusion expects <label>=<text>: ${raw}`)
        options.conclusions.set(raw.slice(0, separator), raw.slice(separator + 1))
        break
      }
      case "--sign": {
        const raw = value()
        const separator = raw.indexOf("=")
        if (separator <= 0) throw new ReleaseEvidenceError(`--sign expects <role>=<actor>: ${raw}`)
        options.signs.push({ role: raw.slice(0, separator), actor: raw.slice(separator + 1), at: "" })
        break
      }
      default:
        if (arg.startsWith("-")) throw new ReleaseEvidenceError(`unknown argument: ${arg}`)
        positional.push(arg)
    }
  }
  return { command, positional, options }
}

/** Parse `<kind>:<label>[:<path>]` into an evidence entry, hashing the file when present. */
export function parseEvidenceSpec(spec: string, root: string, conclusion: string): EvidenceEntry {
  const first = spec.indexOf(":")
  if (first <= 0) throw new ReleaseEvidenceError(`--evidence expects <kind>:<label>[:<path>]: ${spec}`)
  const kind = spec.slice(0, first)
  const remainder = spec.slice(first + 1)
  const second = remainder.indexOf(":")
  const label = second === -1 ? remainder : remainder.slice(0, second)
  const filePath = second === -1 ? undefined : remainder.slice(second + 1)
  if (!EVIDENCE_KINDS.includes(kind as EvidenceKind)) {
    throw new ReleaseEvidenceError(`unknown evidence kind: ${kind} (expected one of ${EVIDENCE_KINDS.join(", ")})`)
  }
  if (!LABEL_PATTERN.test(label)) throw new ReleaseEvidenceError(`invalid evidence label: ${label}`)
  if (filePath === undefined || filePath === "") {
    return { kind: kind as EvidenceKind, label, path: null, sha256: null, conclusion }
  }
  const absolute = path.resolve(root, filePath)
  if (!fs.existsSync(absolute)) throw new ReleaseEvidenceError(`evidence file not found: ${filePath}`)
  const display = absolute.startsWith(`${root}${path.sep}`) ? path.relative(root, absolute) : absolute
  return { kind: kind as EvidenceKind, label, path: display, sha256: sha256OfFile(absolute), conclusion }
}

function gitHead(root: string): string {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root })
  if (result.exitCode !== 0) {
    throw new ReleaseEvidenceError(
      `cannot resolve git HEAD in ${root}; pass --commit explicitly\n${result.stderr.toString().trim()}`,
    )
  }
  return result.stdout.toString().trim()
}

function requireGateID(options: CliOptions): string {
  if (options.gateID === undefined) throw new ReleaseEvidenceError("--gate is required")
  return options.gateID
}

async function runArchive(options: CliOptions): Promise<void> {
  const gateID = requireGateID(options)
  const commit = options.commit ?? gitHead(options.root)
  const now = new Date()
  const evidence = options.evidenceSpecs.map((spec) => {
    const entry = parseEvidenceSpec(spec, options.root, "")
    const conclusion = options.conclusions.get(entry.label)
    if (conclusion === undefined) {
      throw new ReleaseEvidenceError(`evidence ${entry.label}: missing --conclusion ${entry.label}=<text>`)
    }
    return { ...entry, conclusion }
  })
  for (const label of options.conclusions.keys()) {
    if (!evidence.some((entry) => entry.label === label)) {
      throw new ReleaseEvidenceError(`--conclusion ${label}: no matching --evidence entry`)
    }
  }
  const target = archiveGate({
    root: options.root,
    version: options.version,
    gateID,
    commit,
    date: options.date ?? now.toISOString().slice(0, 10),
    generatedAt: options.generatedAtForTest ?? now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    status: options.status,
    summary: options.summary,
    evidence,
    signatures: options.signs,
  })
  console.log(`release-evidence: archived gate ${gateID} at ${path.relative(options.root, target)}`)
}

function runCheck(options: CliOptions, positional: string[]): void {
  let targets: string[]
  if (positional.length > 0) {
    targets = positional.map((entry) => path.resolve(entry))
  } else {
    const gateID = requireGateID(options)
    targets = findManifestPaths(options.root, options.version, gateID, options.commit)
    if (targets.length === 0) {
      const where = options.commit
        ? manifestPathFor(options.root, options.version, options.commit, gateID)
        : path.join(options.root, EVIDENCE_DIRNAME, options.version, "<commit>", gateID, MANIFEST_FILENAME)
      throw new ReleaseEvidenceError(`no manifest found for gate ${gateID} (expected ${where})`)
    }
  }
  let failed = 0
  for (const target of targets) {
    const result = checkManifest(target)
    if (result.ok) {
      console.log(`release-evidence: OK ${path.relative(options.root, target) || target}`)
      continue
    }
    failed += 1
    console.error(`release-evidence: TAMPERED/INVALID ${path.relative(options.root, target) || target}`)
    for (const failure of result.failures) console.error(`  - ${failure}`)
  }
  if (failed > 0) process.exit(1)
}

const USAGE = [
  "usage:",
  "  bun script/release-evidence.ts archive --gate <gate-id> [options]",
  "  bun script/release-evidence.ts check --gate <gate-id> [--commit <sha>] [--version v4.1] [--root <dir>]",
  "  bun script/release-evidence.ts check <path/to/manifest.json>",
  "",
  "options:",
  "  --gate <id>                    gate id, e.g. release-gate-20260819",
  "  --commit <sha>                 full commit sha (default: git rev-parse HEAD)",
  "  --version <release>            release line (default v4.1)",
  "  --date <YYYY-MM-DD>            gate date (default: today UTC)",
  "  --status <s>                   passed|failed|blocked|not_run (default passed)",
  "  --summary <text>               overall gate conclusion",
  "  --evidence <kind>:<label>[:<path>]  evidence entry, repeatable",
  "  --conclusion <label>=<text>    conclusion for an evidence entry, repeatable",
  "  --sign <role>=<actor>          signature placeholder, repeatable",
  "  --root <dir>                   repo root (default: script parent dir)",
].join("\n")

async function main(): Promise<void> {
  try {
    const { command, positional, options } = parseCliArgs(process.argv.slice(2))
    if (command === "archive") await runArchive(options)
    else runCheck(options, positional)
  } catch (error) {
    if (error instanceof ReleaseEvidenceError) {
      console.error(`release-evidence: ${error.message}\n\n${USAGE}`)
      process.exit(2)
    }
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

if (import.meta.main) await main()
