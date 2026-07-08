import { readFileSync } from "node:fs"
import { basename, join, relative } from "node:path"
import { readdirSyncStat } from "../util/fs"
import { isExcludedFile, redactSecrets } from "../util/secrets"
import type { ImportSource, MemoryItem } from "../ir"

/**
 * Memory parsing + knowledge-doc mapping.
 *
 * Both Codex (`~/.codex/memories/*.md`) and Claude Code
 * (`~/.claude/projects/<enc>/memory/*.md`) store memory as Markdown, optionally
 * with YAML frontmatter (`name` / `description` / `metadata`). We parse each
 * file into a {@link MemoryItem}; the writer decides whether to stage it as a
 * knowledge candidate or append it to AGENTS.md.
 */

/** Parse `---\nkey: value\n---` frontmatter; returns {front, body}. */
export function parseFrontmatter(input: string): { front: Record<string, string>; body: string } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(input)
  if (!match) return { front: {}, body: input }
  const front: Record<string, string> = {}
  for (const raw of match[1].split(/\r?\n/)) {
    const idx = raw.indexOf(":")
    if (idx <= 0) continue
    const key = raw.slice(0, idx).trim()
    let value = raw.slice(idx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key) front[key] = value
  }
  return { front, body: match[2] }
}

function slugFromFile(file: string): string {
  return basename(file)
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function titleFromBody(body: string): string {
  const heading = /^\s*#\s+(.+)$/m.exec(body)
  return heading ? heading[1].trim().slice(0, 120) : body.split(/\n/)[0]?.slice(0, 120) ?? "memory"
}

/** Walk a directory for `.md` memory files; `.git` and excluded files are skipped. */
export function fromMarkdownTree(source: ImportSource, root: string): MemoryItem[] {
  const items: MemoryItem[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSyncStat(dir)) {
      const rel = relative(root, entry.path)
      if (entry.isDirectory) {
        if (basename(entry.path) === ".git") continue
        walk(entry.path)
        continue
      }
      if (!entry.isFile || !entry.path.endsWith(".md")) continue
      if (isExcludedFile(rel)) continue
      let text: string
      try {
        text = readFileSync(entry.path, "utf8")
      } catch {
        continue
      }
      const { front, body } = parseFrontmatter(text)
      const clean = redactSecrets(body).text
      items.push({
        source,
        slug: front.name || slugFromFile(entry.path),
        title: front.description ? titleFromBody(clean) : titleFromBody(clean),
        description: front.description,
        body: clean,
        originSessionId: front.originSessionId,
      })
    }
  }
  try {
    walk(root)
  } catch {
    /* root missing */
  }
  return items
}
