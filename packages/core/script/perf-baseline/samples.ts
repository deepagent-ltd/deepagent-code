import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"

export const UNIT = "ms"

export interface SampleGroup {
  readonly name: string
  readonly values: readonly number[]
  /** Physical unit of the values; defaults to UNIT ("ms") when omitted. */
  readonly unit?: string
}

export class Collector {
  readonly groups = new Map<string, number[]>()

  add(group: string, value: number) {
    if (!Number.isFinite(value)) throw new TypeError(`non-finite sample in ${group}: ${value}`)
    const bucket = this.groups.get(group)
    if (bucket) bucket.push(value)
    else this.groups.set(group, [value])
  }

  get all(): SampleGroup[] {
    return Array.from(this.groups.entries()).map(([name, values]) => ({ name, values }))
  }

  get total(): number {
    return this.all.reduce((total, group) => total + group.values.length, 0)
  }
}

export const sha256Short = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex").slice(0, 12)

const writeFileAtomic = (target: string, body: string) => {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temp = `${target}.tmp`
  fs.writeFileSync(temp, body)
  fs.renameSync(temp, target)
}

export const csvEscape = (value: string | number) => {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** One CSV per collector: every raw sample is a row; nothing is filtered. */
export const writeSamplesCsv = (target: string, scenario: string, groups: readonly SampleGroup[]) => {
  const header = ["scenario", "group", "sample_index_in_group", `value_${groups[0]?.unit ?? UNIT}`]
  const rows: string[] = [header.join(",")]
  for (const group of groups) {
    group.values.forEach((value, index) => rows.push([scenario, group.name, index, value].map(csvEscape).join(",")))
  }
  writeFileAtomic(target, `${rows.join("\n")}\n`)
}

/** One JSON line per group-summary; structure kept loose by design (per-scenario extras vary). */
export type SummaryRow = Record<string, unknown>

export const writeSummariesJsonl = (target: string, rows: readonly SummaryRow[]) => {
  const body = rows.map((row) => JSON.stringify(row)).join("\n")
  writeFileAtomic(target, `${body}${rows.length === 0 ? "" : "\n"}`)
}

export interface ArtifactFile {
  readonly path: string
  readonly sha256_12: string
  readonly bytes: number
}

export const recordArtifact = (outputDir: string, relativePath: string): ArtifactFile => {
  const absolute = path.join(outputDir, relativePath)
  const bytes = fs.statSync(absolute).size
  return { path: relativePath, sha256_12: sha256Short(fs.readFileSync(absolute)), bytes }
}
