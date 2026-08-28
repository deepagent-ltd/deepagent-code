import { promises as fs } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import { ZipReader, ZipWriter, BlobReader, BlobWriter } from "@zip.js/zip.js"

export type FileOpResult = { ok: true } | { ok: false; error: string }

/**
 * Ensure every absolute path passed to a file-ops handler stays inside the workspace root.
 * The renderer sends the workspace directory as `root`; any target/destination that resolves
 * outside it is rejected before touching the filesystem, so a malicious or buggy renderer
 * cannot use the local file-ops bridge to delete/move arbitrary files.
 */
export function assertWithinRoot(root: string, ...paths: string[]): FileOpResult | null {
  const rootResolved = resolve(root)
  for (const p of paths) {
    const rel = relative(rootResolved, resolve(p))
    if (rel.startsWith("..")) return { ok: false, error: "Path is outside the workspace" }
  }
  return null
}

/**
 * Guard the positional path arguments of an IPC file-op call. Most handlers pass every string
 * arg here; `rename` is the documented exception — its `nextName` is a bare filename that resolves
 * against cwd (homedir in the desktop main process), so it must NOT be passed, only the `target`.
 * Extracted so the IPC layer's guard strategy is unit-testable without the Electron runtime.
 */
export function guardFileOpCall(root: string, guardPaths: readonly string[]): FileOpResult | null {
  return assertWithinRoot(root, ...guardPaths)
}

/** Run an async file operation, returning a structured result instead of throwing. */
async function attempt(fn: () => Promise<unknown>): Promise<FileOpResult> {
  try {
    await fn()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function readToBlob(filePath: string): Promise<Blob> {
  const buffer = await fs.readFile(filePath)
  return new Blob([new Uint8Array(buffer)])
}

async function writeBlob(filePath: string, blob: Blob): Promise<void> {
  const buffer = Buffer.from(await blob.arrayBuffer())
  await fs.mkdir(dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, buffer)
}

/** Resolve a non-colliding output path by appending " (n)" before the extension. */
async function uniquePath(target: string): Promise<string> {
  const dir = dirname(target)
  const base = basename(target)
  const dot = base.lastIndexOf(".")
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ""

  let candidate = target
  let n = 1
  while (await exists(candidate)) {
    candidate = join(dir, `${stem} (${n})${ext}`)
    n++
  }
  return candidate
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

export async function copyPath(source: string, destDir: string): Promise<FileOpResult> {
  return attempt(async () => {
    const base = basename(source)
    const dest = await uniquePath(join(destDir, base))
    const stat = await fs.stat(source)
    if (stat.isDirectory()) {
      await fs.cp(source, dest, { recursive: true })
    } else {
      await fs.copyFile(source, dest)
    }
  })
}

export async function movePath(source: string, destDir: string): Promise<FileOpResult> {
  return attempt(async () => {
    const base = basename(source)
    const dest = await uniquePath(join(destDir, base))
    // fs.rename is atomic and cheap but fails with EXDEV across filesystems (e.g. Windows C:→D:,
    // Linux cross-mount, or a tmpfs → disk move). Fall back to copy-then-remove so a cross-device
    // move still succeeds instead of surfacing an opaque OS error to the user.
    try {
      await fs.rename(source, dest)
    } catch (error) {
      if (!isCrossDevice(error)) throw error
      const stat = await fs.stat(source)
      if (stat.isDirectory()) {
        await fs.cp(source, dest, { recursive: true })
      } else {
        await fs.copyFile(source, dest)
      }
      await fs.rm(source, { recursive: true, force: true })
    }
  })
}

function isCrossDevice(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code
  return code === "EXDEV" || code === "ENOTSUP"
}

export async function removePath(target: string): Promise<FileOpResult> {
  return attempt(async () => {
    await fs.rm(target, { recursive: true, force: true })
  })
}

// Windows reserves these characters in filenames. They are illegal on Win32 and problematic
// elsewhere, so we reject them up front with a clear message instead of letting fs.rename fail
// with an opaque OS error.
const ILLEGAL_NAME_CHARS = /[<>:"|?*\x00-\x1f]/

export async function renamePath(target: string, nextName: string): Promise<FileOpResult> {
  return attempt(async () => {
    const clean = nextName.trim()
    if (!clean) throw new Error("Name cannot be empty")
    if (clean.includes("/") || clean.includes("\\")) throw new Error("Name cannot contain path separators")
    if (ILLEGAL_NAME_CHARS.test(clean)) throw new Error("Name contains illegal characters")
    const dest = join(dirname(target), clean)
    if (await exists(dest)) throw new Error(`"${clean}" already exists`)
    await fs.rename(target, dest)
  })
}

async function addDirectoryToZip(writer: ZipWriter<Blob>, dir: string, prefix: string): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    const entryName = `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      await addDirectoryToZip(writer, fullPath, entryName)
    } else if (entry.isFile()) {
      await writer.add(entryName, new BlobReader(await readToBlob(fullPath)))
    }
  }
}

export async function archivePath(target: string): Promise<FileOpResult & { path?: string }> {
  try {
    const stat = await fs.stat(target)
    const base = basename(target)
    const outPath = await uniquePath(join(dirname(target), `${base}.zip`))
    const writer = new ZipWriter(new BlobWriter("application/zip"))
    if (stat.isDirectory()) {
      await addDirectoryToZip(writer, target, base)
    } else {
      await writer.add(base, new BlobReader(await readToBlob(target)))
    }
    const zip = await writer.close()
    await writeBlob(outPath, zip)
    return { ok: true, path: outPath }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Guard against zip entry paths that escape the destination directory (path traversal). */
function safeJoin(root: string, entryPath: string): string | null {
  const resolved = join(root, entryPath)
  const rel = relative(root, resolved)
  if (rel.startsWith("..") || join(root, rel) !== resolved) return null
  return resolved
}

export async function extractPath(zipPath: string): Promise<FileOpResult & { path?: string }> {
  try {
    const base = basename(zipPath).replace(/\.zip$/i, "")
    const outDir = await uniquePath(join(dirname(zipPath), base))
    await fs.mkdir(outDir, { recursive: true })

    const reader = new ZipReader(new BlobReader(await readToBlob(zipPath)))
    try {
      const entries = await reader.getEntries()
      for (const entry of entries) {
        const target = safeJoin(outDir, entry.filename)
        if (!target) continue
        if (entry.directory) {
          await fs.mkdir(target, { recursive: true })
          continue
        }
        if (!entry.getData) continue
        await fs.mkdir(dirname(target), { recursive: true })
        const data = await entry.getData(new BlobWriter())
        await writeBlob(target, data)
      }
    } finally {
      await reader.close()
    }
    return { ok: true, path: outDir }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
