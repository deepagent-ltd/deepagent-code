import fs from "node:fs/promises"
import { constants, type Stats } from "node:fs"
import path from "node:path"
import { Hash } from "@deepagent-code/core/util/hash"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { parseCodexCooperative } from "./source/codex"
import { parseClaudeCooperative } from "./source/claude"
import { isExcludedFile } from "./util/secrets"
import type { ImportSource, SourceSession } from "./ir"

export const DEFAULT_BUDGET = {
  entries: 10_000,
  fileBytes: 16 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  sessions: 5_000,
  turns: 100_000,
  depth: 32,
}
export type Budget = typeof DEFAULT_BUDGET

export function budget(environment: NodeJS.ProcessEnv): Budget {
  return Object.fromEntries(
    Object.entries(DEFAULT_BUDGET).map(([key, fallback]) => {
      const raw =
        environment[`DEEPAGENT_CODE_IMPORT_MAX_${key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`]
      if (raw === undefined) return [key, fallback]
      const value = Number(raw)
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`IMPORT_BUDGET_INVALID: ${key}=${raw}`)
      return [key, value]
    }),
  ) as Budget
}

export async function snapshot(input: {
  source: ImportSource
  sourcePath: string
  destination: string
  cwdFilter?: string
  budget: Budget
  checkpoint: () => Promise<void>
}) {
  const counters = { entries: 0, totalBytes: 0, sessions: 0, turns: 0 }
  const manifest: { path: string; size: number; sha256: string }[] = []
  if ((await fs.lstat(input.sourcePath)).isSymbolicLink()) throw new Error("IMPORT_SOURCE_SYMLINK: source root")
  const root = await fs.realpath(input.sourcePath)
  if (!(await fs.stat(root)).isDirectory()) throw new Error("IMPORT_SOURCE_UNAVAILABLE: source must be a directory")
  await fs.mkdir(input.destination, { recursive: true, mode: 0o700 })
  const destination = await fs.realpath(input.destination)
  const check = (key: keyof Budget, actual: number) => {
    if (actual > input.budget[key])
      throw new Error(`IMPORT_BUDGET_EXCEEDED: ${key} actual=${actual} limit=${input.budget[key]}`)
  }
  const copy = async (name: string, before: Stats) => {
    const filename = path.join(root, name)
    check("fileBytes", before.size)
    check("totalBytes", counters.totalBytes + before.size)
    // O_NOFOLLOW protects the final component. Verify its opened identity and parent
    // realpath as well, rather than trusting an earlier lstat of a replaceable path.
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
    const bytes = await (async () => {
      try {
        const opened = await handle.stat()
        const actual = await fs.realpath(filename)
        if (
          !opened.isFile() ||
          opened.dev !== before.dev ||
          opened.ino !== before.ino ||
          opened.size !== before.size ||
          actual !== filename
        )
          throw new Error(`IMPORT_SOURCE_CHANGED: ${name}`)
        const content = Buffer.alloc(opened.size)
        const read = await handle.read(content, 0, content.length, 0)
        const after = await handle.stat()
        if (
          read.bytesRead !== content.length ||
          after.size !== opened.size ||
          after.mtimeMs !== opened.mtimeMs ||
          after.ctimeMs !== opened.ctimeMs
        )
          throw new Error(`IMPORT_SOURCE_CHANGED: ${name}`)
        return content
      } finally {
        await handle.close()
      }
    })()
    counters.totalBytes += bytes.length
    const dest = path.join(destination, name)
    await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 })
    await fs.writeFile(dest, bytes, { flag: "wx", mode: 0o600 })
    manifest.push({ path: name.split(path.sep).join("/"), size: bytes.length, sha256: Hash.sha256(bytes) })
  }
  const walk = async (relative: string, depth: number): Promise<void> => {
    await input.checkpoint()
    check("depth", depth)
    const entries = []
    // Limit enumeration before allocating or sorting the entire directory. The iterator
    // closes its handle on early rejection/cancellation, including oversized directories.
    for await (const entry of await fs.opendir(path.join(root, relative))) {
      await input.checkpoint()
      check("entries", ++counters.entries)
      entries.push(entry)
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      await input.checkpoint()
      const name = path.join(relative, entry.name)
      if (isExcludedFile(name)) continue
      const filename = path.join(root, name)
      const before = await fs.lstat(filename)
      if (before.isSymbolicLink()) throw new Error(`IMPORT_SOURCE_SYMLINK: ${name}`)
      if (before.isDirectory()) {
        await walk(name, depth + 1)
        continue
      }
      // Skill assets are part of the frozen input, including nested scripts and binary files.
      if (
        !before.isFile() ||
        (!/\.(jsonl|md)$/i.test(entry.name) && !(input.source === "claude" && name.startsWith(`skills${path.sep}`)))
      )
        continue
      await copy(name, before)
    }
  }
  // Snapshot only roots that the import parsers can consume, never the surrounding
  // credentials/configuration tree. Every accepted byte is bound by this manifest.
  const roots = input.source === "codex" ? ["sessions", "memories"] : ["projects", "skills"]
  for (const name of roots) {
    const stat = await fs.lstat(path.join(root, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!stat) continue
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`IMPORT_SOURCE_SYMLINK: ${name}`)
    await walk(name, 1)
  }
  if (input.source === "codex") {
    const index = await fs.lstat(path.join(root, "session_index.jsonl")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (index) {
      check("entries", ++counters.entries)
      if (!index.isFile() || index.isSymbolicLink()) throw new Error("IMPORT_SOURCE_SYMLINK: session_index.jsonl")
      await copy("session_index.jsonl", index)
    }
  }
  const options = {
    ...input,
    onSession: (session: SourceSession) => {
      check("sessions", ++counters.sessions)
      counters.turns += session.turns.length
      check("turns", counters.turns)
    },
  }
  const parsed =
    input.source === "codex"
      ? await parseCodexCooperative(destination, options)
      : await parseClaudeCooperative(destination, options)
  check("sessions", parsed.sessions.length)
  check(
    "turns",
    parsed.sessions.reduce((count, session) => count + session.turns.length, 0),
  )
  const encoded = CanonicalJson.stringify({ format: 1, source: input.source, manifest, parsed })
  const filename = path.join(path.dirname(destination), "source.json")
  await fs.writeFile(filename, encoded, { flag: "wx", mode: 0o600 })
  return { parsed, manifest, digest: Hash.sha256(encoded), path: filename, root, counters }
}
