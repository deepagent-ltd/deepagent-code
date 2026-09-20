#!/usr/bin/env bun
/**
 * Replay-history extraction (2026-09-10): curate human operations out of local deepagent-code
 * history databases into a replayable scenario manifest.
 *
 *   bun run script/replay-history/extract.ts [--db <path>]... [--out <dir>] [--max-per-bucket N]
 *
 * Sources open READ-ONLY. A "human operation" is a user-role message carrying a text part and no
 * compaction marker; drill/import snapshots collapse via a content hash over the op sequence.
 * The manifest keeps full op text (local machine only); the markdown report shows previews.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { Database } from "bun:sqlite"

const args = process.argv.slice(2)
const option = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const databases = args
  .map((value, index) => (args[index - 1] === "--db" ? value : undefined))
  .filter((value): value is string => value !== undefined)
const outDir = option("--out") ?? "/tmp/replay-history"
const maxPerBucket = Number(option("--max-per-bucket") ?? 4)

type Op = { readonly kind: "prompt"; readonly text: string; readonly ts: number }
type Scenario = {
  readonly id: string
  readonly source: string
  readonly sessionID: string
  readonly directory: string
  readonly agent: string | null
  readonly ops: readonly Op[]
  readonly tags: readonly string[]
  readonly stats: {
    readonly userTurns: number
    readonly toolParts: number
    readonly assistantMessages: number
    readonly textBytes: number
    readonly forkChildren: number
    readonly wasCompacted: boolean
    readonly hasAttachment: boolean
  }
}

const buckets: Record<string, Scenario[]> = {}
const seenHashes = new Set<string>()
let skippedDuplicates = 0

for (const database of databases) {
  const label = path.basename(database, ".db")
  const db = new Database(`file:${database}?mode=ro`, { readonly: true })
  const forkParents = new Map<string, number>()
  for (const row of db.query("SELECT parent_id FROM session WHERE parent_id IS NOT NULL").all() as { parent_id: string }[])
    forkParents.set(row.parent_id, (forkParents.get(row.parent_id) ?? 0) + 1)

  const sessions = db
    .query("SELECT id, directory, agent, time_compacting FROM session ORDER BY time_created")
    .all() as { id: string; directory: string | null; agent: string | null; time_compacting: number | null }[]
  for (const session of sessions) {
    const messages = db
      .query("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id")
      .all(session.id) as { id: string; data: string }[]
    const partsByMessage = new Map<string, { type: string; text?: string }[]>()
    for (const part of db
      .query("SELECT message_id, json_extract(data,'$.type') AS type, json_extract(data,'$.text') AS text FROM part WHERE session_id = ?")
      .all(session.id) as { message_id: string; type: string | null; text: string | null }[]) {
      const list = partsByMessage.get(part.message_id) ?? []
      list.push({ type: part.type ?? "", text: part.text ?? undefined })
      partsByMessage.set(part.message_id, list)
    }

    const ops: Op[] = []
    let toolParts = 0
    let assistantMessages = 0
    let hasAttachment = false
    for (const message of messages) {
      const info = JSON.parse(message.data) as { role?: string; time?: { created?: number } }
      const parts = partsByMessage.get(message.id) ?? []
      if (info.role === "assistant") assistantMessages += 1
      for (const part of parts) {
        if (part.type === "tool") toolParts += 1
        if (part.type === "file") hasAttachment = true
      }
      // A human prompt: user role, a text part, and no compaction marker part.
      if (info.role !== "user") continue
      if (parts.some((part) => part.type === "compaction")) continue
      const textPart = parts.find((part) => part.type === "text" && typeof part.text === "string")
      if (!textPart || !textPart.text?.trim()) continue
      ops.push({ kind: "prompt", text: textPart.text, ts: info.time?.created ?? 0 })
    }
    if (ops.length === 0) continue

    const textBytes = ops.reduce((sum, op) => sum + op.text.length, 0)
    const hash = createHash("sha256")
      .update(`${session.agent ?? ""}\u0000${ops.map((op) => op.text).join("\u0001")}`)
      .digest("hex")
    if (seenHashes.has(hash)) {
      skippedDuplicates += 1
      continue
    }
    seenHashes.add(hash)

    const userTurns = ops.length
    const tags = [
      userTurns === 1 ? "single-turn" : userTurns <= 5 ? "short" : userTurns <= 15 ? "medium" : "long",
      toolParts >= 3 * userTurns ? "tool-heavy" : toolParts > 0 ? "some-tools" : "no-tools",
      textBytes > 4000 ? "long-text" : undefined,
      (forkParents.get(session.id) ?? 0) > 0 ? "forked-from" : undefined,
      session.time_compacting ? "was-compacted" : undefined,
      hasAttachment ? "attachment" : undefined,
    ].filter((tag): tag is string => tag !== undefined)
    const scenario: Scenario = {
      id: `${label}-${session.id.slice(-10)}`,
      source: label,
      sessionID: session.id,
      directory: session.directory ?? "",
      agent: session.agent,
      ops,
      tags,
      stats: {
        userTurns,
        toolParts,
        assistantMessages,
        textBytes,
        forkChildren: forkParents.get(session.id) ?? 0,
        wasCompacted: Boolean(session.time_compacting),
        hasAttachment,
      },
    }
    for (const tag of tags) (buckets[tag] ??= []).push(scenario)
  }
  db.close()
}

// Stratified shortlist: the richest scenarios per tag bucket (ops count + tool use as richness).
const selected = new Map<string, Scenario>()
for (const [tag, list] of Object.entries(buckets)) {
  const ranked = [...list].sort(
    (a, b) => b.stats.userTurns + b.stats.toolParts / 4 - (a.stats.userTurns + a.stats.toolParts / 4),
  )
  for (const scenario of ranked.slice(0, maxPerBucket)) selected.set(scenario.id, scenario)
}
// Always include one representative single-turn scenario even though it ranks lowest elsewhere.
for (const scenario of (buckets["single-turn"] ?? []).slice(0, 1)) selected.set(scenario.id, scenario)

const manifest = {
  generatedAt: new Date().toISOString(),
  sources: databases,
  dedupedDuplicates: skippedDuplicates,
  totalUnique: seenHashes.size,
  shortlist: [...selected.values()],
}
mkdirSync(outDir, { recursive: true })
writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)

const rows = [...selected.values()].map((scenario) => {
  const preview = scenario.ops[0]!.text.replace(/\s+/g, " ").slice(0, 80)
  return `| ${scenario.id} | ${scenario.stats.userTurns} | ${scenario.stats.toolParts} | ${scenario.stats.assistantMessages} | ${scenario.tags.join(", ")} | ${preview} |`
})
writeFileSync(
  path.join(outDir, "scenarios.md"),
  `# Replay scenarios (${selected.size} shortlisted of ${seenHashes.size} unique; ${skippedDuplicates} duplicates skipped)\n\n` +
    `| id | user turns | tool parts | assistant msgs | tags | first prompt |\n|---|---|---|---|---|---|\n` +
    rows.join("\n") +
    "\n",
)
console.error(`unique=${seenHashes.size} duplicates=${skippedDuplicates} shortlist=${selected.size} -> ${outDir}`)
