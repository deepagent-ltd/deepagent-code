import { Ignore } from "@deepagent-code/core/filesystem/ignore"
import ignore from "ignore"
import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import path from "node:path"

const Sensitive = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:credentials?|secrets?|tokens?)(?:\.|$)/i,
  /\.(?:pem|key|p12|pfx|jks)$/i,
  /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/i,
]

const TextExtensions = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html", ".java", ".js", ".jsx",
  ".json", ".jsonc", ".kt", ".kts", ".lua", ".md", ".mdx", ".php", ".py", ".rb", ".rs", ".sh",
  ".sql", ".svelte", ".swift", ".toml", ".ts", ".tsx", ".txt", ".vue", ".xml", ".yaml", ".yml",
])

export type File = {
  readonly path: string
  readonly absolutePath: string
  readonly content: string
  readonly mtimeNs: string
}

export type Result = {
  readonly files: readonly File[]
  readonly complete: boolean
  readonly skippedSensitive: number
  readonly skippedBinary: number
  readonly totalBytes: number
}

export async function scan(input: {
  readonly root: string
  readonly maxFiles?: number
  readonly maxBytes?: number
  readonly deadline?: number
}) {
  const root = await realpath(input.root)
  const matcher = ignore()
  const gitignore = await readFile(path.join(root, ".gitignore"), "utf8").catch(() => "")
  if (gitignore) matcher.add(gitignore)
  const maxFiles = Math.min(input.maxFiles ?? 20_000, 100_000)
  const maxBytes = Math.min(input.maxBytes ?? 128 * 1024 * 1024, 512 * 1024 * 1024)
  const deadline = input.deadline ?? Number.POSITIVE_INFINITY
  const files: File[] = []
  let totalBytes = 0
  let skippedSensitive = 0
  let skippedBinary = 0
  let complete = true

  const walk = async (directory: string): Promise<void> => {
    if (!complete) return
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (Date.now() >= deadline || files.length >= maxFiles || totalBytes >= maxBytes) {
        complete = false
        return
      }
      const absolutePath = path.join(directory, entry.name)
      const relative = normalizeRelative(root, absolutePath)
      if (!relative || Ignore.match(relative) || matcher.ignores(relative)) continue
      if (entry.isDirectory()) {
        await walk(absolutePath)
        continue
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      if (isSensitivePath(relative)) {
        skippedSensitive++
        continue
      }
      const extension = path.extname(relative).toLowerCase()
      if (!TextExtensions.has(extension) && !isExtensionlessDocument(relative)) continue
      const info = await lstat(absolutePath).catch(() => undefined)
      if (!info || info.size > 1024 * 1024) continue
      const canonical = await realpath(absolutePath).catch(() => undefined)
      if (!canonical || !inside(root, canonical)) continue
      const content = await readFile(canonical).catch(() => undefined)
      if (!content) continue
      if (content.subarray(0, Math.min(content.byteLength, 8_192)).includes(0)) {
        skippedBinary++
        continue
      }
      if (totalBytes + content.byteLength > maxBytes) {
        complete = false
        return
      }
      totalBytes += content.byteLength
      files.push({
        path: relative,
        absolutePath: canonical,
        content: content.toString("utf8"),
        mtimeNs: String(BigInt(Math.trunc(info.mtimeMs * 1_000_000))),
      })
    }
  }
  await walk(root)
  return { files, complete, skippedSensitive, skippedBinary, totalBytes } satisfies Result
}

export function isRepoDocument(filePath: string) {
  const basename = path.posix.basename(filePath).toLowerCase()
  const extension = path.posix.extname(filePath).toLowerCase()
  return (
    [".md", ".mdx", ".txt"].includes(extension) &&
    (/^(readme|contributing|changelog|architecture|design|requirements?|runbook)/i.test(basename) ||
      /(^|\/)(docs?|adr|specs?|requirements?|design|runbooks?)(\/|$)/i.test(filePath))
  )
}

export function isSensitivePath(filePath: string) {
  return Sensitive.some((pattern) => pattern.test(filePath))
}

export function normalizeRelative(root: string, target: string) {
  const relative = path.relative(root, target).split(path.sep).join("/")
  if (!relative || relative.startsWith("../") || path.posix.isAbsolute(relative)) return
  return relative
}

function inside(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function isExtensionlessDocument(filePath: string) {
  return /(^|\/)(readme|license|notice|dockerfile|makefile)$/i.test(filePath)
}
