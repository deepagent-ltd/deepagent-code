import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { BlobReader, ZipWriter, BlobWriter } from "@zip.js/zip.js"
import { archivePath, assertWithinRoot, copyPath, extractPath, guardFileOpCall, movePath, removePath, renamePath } from "./file-ops"

// Each test gets a fresh temp directory cleaned up in finally. We use real fs + real zip.js so the
// test exercises the same code path as production instead of re-implementing the logic.

async function tmpDir() {
  const dir = await mkdtemp(join(tmpdir(), "deepagent-code-fileops-"))
  return dir
}

async function writeText(path: string, content: string) {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, content, "utf8")
}

describe("copyPath", () => {
  test("copies a single file into a destination directory", async () => {
    const dir = await tmpDir()
    try {
      await writeText(join(dir, "src.txt"), "hello")
      await mkdir(join(dir, "dest"))
      const res = await copyPath(join(dir, "src.txt"), join(dir, "dest"))
      expect(res.ok).toBe(true)
      expect(await readFile(join(dir, "dest", "src.txt"), "utf8")).toBe("hello")
      // source remains
      expect(await readFile(join(dir, "src.txt"), "utf8")).toBe("hello")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("recursively copies a directory tree", async () => {
    const dir = await tmpDir()
    try {
      await writeText(join(dir, "root", "a.txt"), "a")
      await writeText(join(dir, "root", "sub", "b.txt"), "b")
      const res = await copyPath(join(dir, "root"), join(dir, "out"))
      expect(res.ok).toBe(true)
      expect(await readFile(join(dir, "out", "root", "a.txt"), "utf8")).toBe("a")
      expect(await readFile(join(dir, "out", "root", "sub", "b.txt"), "utf8")).toBe("b")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("picks a non-colliding name when the target already exists", async () => {
    const dir = await tmpDir()
    try {
      await writeText(join(dir, "src.txt"), "first")
      await writeText(join(dir, "dest", "src.txt"), "second")
      const res = await copyPath(join(dir, "src.txt"), join(dir, "dest"))
      expect(res.ok).toBe(true)
      expect(await readFile(join(dir, "dest", "src.txt"), "utf8")).toBe("second")
      expect(await readFile(join(dir, "dest", "src (1).txt"), "utf8")).toBe("first")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("movePath", () => {
  test("moves a file and removes the source", async () => {
    const dir = await tmpDir()
    try {
      await writeText(join(dir, "src.txt"), "data")
      await mkdir(join(dir, "dest"))
      const res = await movePath(join(dir, "src.txt"), join(dir, "dest"))
      expect(res.ok).toBe(true)
      expect(await readFile(join(dir, "dest", "src.txt"), "utf8")).toBe("data")
      await expect(stat(join(dir, "src.txt"))).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("falls back to copy+remove when rename fails with EXDEV (cross-device)", async () => {
    // Cross-device moves (Windows C:→D:, Linux cross-mount) make fs.rename throw EXDEV. We trigger
    // a REAL cross-device rename by moving between /dev/shm (tmpfs) and the OS tmpdir (disk), so
    // the test exercises the actual fallback path rather than a stub. Skipped where /dev/shm is
    // unavailable (Windows, some CI sandboxes) or on the same device as tmpdir.
    const { existsSync } = await import("node:fs")
    const shmDir = "/dev/shm"
    if (!existsSync(shmDir)) return
    let srcDir: string | undefined
    let destDir: string | undefined
    try {
      srcDir = await mkdtemp(join(shmDir, "deepagent-code-exdev-"))
      destDir = await tmpDir()
      await writeText(join(srcDir, "src.txt"), "cross-device data")
      // Sanity check that this environment actually produces EXDEV here; if not, the fallback is
      // untestable here and we skip rather than pass vacuously.
      const fs = await import("node:fs/promises")
      try {
        await fs.rename(join(srcDir, "src.txt"), join(destDir, "probe"))
        // rename succeeded → same device → can't test EXDEV here
        return
      } catch (e) {
        if ((e as { code?: string }).code !== "EXDEV") return
        // restore the probe (it moved) so the real test starts clean
      }
      const res = await movePath(join(srcDir, "src.txt"), destDir)
      expect(res.ok).toBe(true)
      expect(await readFile(join(destDir, "src.txt"), "utf8")).toBe("cross-device data")
      await expect(stat(join(srcDir, "src.txt"))).rejects.toThrow()
    } finally {
      if (srcDir) await rm(srcDir, { recursive: true, force: true })
      if (destDir) await rm(destDir, { recursive: true, force: true })
    }
  })
})

describe("removePath", () => {
  test("deletes a file", async () => {
    const dir = await tmpDir()
    try {
      const file = join(dir, "gone.txt")
      await writeText(file, "x")
      const res = await removePath(file)
      expect(res.ok).toBe(true)
      await expect(stat(file)).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("deletes a non-empty directory recursively", async () => {
    const dir = await tmpDir()
    try {
      await writeText(join(dir, "tree", "deep", "leaf.txt"), "x")
      const res = await removePath(join(dir, "tree"))
      expect(res.ok).toBe(true)
      await expect(stat(join(dir, "tree"))).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("succeeds when the target does not exist", async () => {
    const dir = await tmpDir()
    try {
      const res = await removePath(join(dir, "never-existed"))
      expect(res.ok).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("renamePath", () => {
  test("renames a file within its directory", async () => {
    const dir = await tmpDir()
    try {
      const file = join(dir, "old.txt")
      await writeText(file, "content")
      const res = await renamePath(file, "new.txt")
      expect(res.ok).toBe(true)
      expect(await readFile(join(dir, "new.txt"), "utf8")).toBe("content")
      await expect(stat(file)).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rejects an empty name", async () => {
    const dir = await tmpDir()
    try {
      const file = join(dir, "old.txt")
      await writeText(file, "content")
      const res = await renamePath(file, "   ")
      expect(res.ok).toBe(false)
      expect(res.error).toBeTruthy()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rejects a name containing path separators", async () => {
    const dir = await tmpDir()
    try {
      const file = join(dir, "old.txt")
      await writeText(file, "content")
      const res = await renamePath(file, "sub/new.txt")
      expect(res.ok).toBe(false)
      expect(res.error).toBeTruthy()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rejects Windows-illegal filename characters", async () => {
    const dir = await tmpDir()
    try {
      const file = join(dir, "old.txt")
      await writeText(file, "content")
      // Each of < > : " | ? * and control chars is rejected on every platform so fs.rename never
      // reaches the OS with a name that would fail opaquely on Windows.
      for (const bad of ["a<b", "a>b", "a:b", 'a"b', "a|b", "a?b", "a*b", "a\u0000b"]) {
        const res = await renamePath(file, bad)
        expect(res.ok).toBe(false)
        expect(res.error).toBeTruthy()
      }
      // original file is untouched after all rejected attempts
      expect(await readFile(file, "utf8")).toBe("content")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rejects a name that collides with an existing entry", async () => {
    const dir = await tmpDir()
    try {
      await writeText(join(dir, "a.txt"), "a")
      await writeText(join(dir, "b.txt"), "b")
      const res = await renamePath(join(dir, "a.txt"), "b.txt")
      expect(res.ok).toBe(false)
      expect(res.error).toBeTruthy()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("archivePath", () => {
  test("zips a single file into <name>.zip", async () => {
    const dir = await tmpDir()
    try {
      await writeText(join(dir, "note.txt"), "archive me")
      const res = await archivePath(join(dir, "note.txt"))
      expect(res.ok).toBe(true)
      expect(res.path).toBe(join(dir, "note.txt.zip"))
      // zip is a real, non-empty file
      const info = await stat(res.path!)
      expect(info.size).toBeGreaterThan(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("zips a directory and preserves nested entries", async () => {
    const dir = await tmpDir()
    try {
      await writeText(join(dir, "project", "index.ts"), "export")
      await writeText(join(dir, "project", "src", "util.ts"), "util")
      const res = await archivePath(join(dir, "project"))
      expect(res.ok).toBe(true)
      expect(res.path).toBe(join(dir, "project.zip"))

      // round-trip: extract and verify contents match
      const extracted = await extractPath(res.path!)
      expect(extracted.ok).toBe(true)
      expect(await readFile(join(extracted.path!, "project", "index.ts"), "utf8")).toBe("export")
      expect(await readFile(join(extracted.path!, "project", "src", "util.ts"), "utf8")).toBe("util")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("picks a non-colliding zip name when one already exists", async () => {
    const dir = await tmpDir()
    try {
      await writeText(join(dir, "f.txt"), "x")
      await writeText(join(dir, "f.txt.zip"), "existing")
      const res = await archivePath(join(dir, "f.txt"))
      expect(res.ok).toBe(true)
      expect(res.path).toBe(join(dir, "f.txt (1).zip"))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("extractPath", () => {
  test("extracts a zip preserving directory structure", async () => {
    const dir = await tmpDir()
    try {
      // build a zip with nested entries
      const writer = new ZipWriter(new BlobWriter("application/zip"))
      await writer.add("top.txt", new BlobReader(new Blob(["top-content"])))
      await writer.add("nested/deep.txt", new BlobReader(new Blob(["deep-content"])))
      const zipBlob = await writer.close()
      const zipPath = join(dir, "bundle.zip")
      await writeFile(zipPath, Buffer.from(await zipBlob.arrayBuffer()))

      const res = await extractPath(zipPath)
      expect(res.ok).toBe(true)
      expect(res.path).toBe(join(dir, "bundle"))
      expect(await readFile(join(res.path!, "top.txt"), "utf8")).toBe("top-content")
      expect(await readFile(join(res.path!, "nested", "deep.txt"), "utf8")).toBe("deep-content")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("ignores entries that escape the destination directory (path traversal)", async () => {
    const dir = await tmpDir()
    try {
      const writer = new ZipWriter(new BlobWriter("application/zip"))
      await writer.add("safe.txt", new BlobReader(new Blob(["safe"])))
      // malicious entry attempting to write outside the extract root
      await writer.add("../escape.txt", new BlobReader(new Blob(["escaped"])))
      const zipBlob = await writer.close()
      const zipPath = join(dir, "evil.zip")
      await writeFile(zipPath, Buffer.from(await zipBlob.arrayBuffer()))

      const res = await extractPath(zipPath)
      expect(res.ok).toBe(true)
      // safe entry extracted
      expect(await readFile(join(res.path!, "safe.txt"), "utf8")).toBe("safe")
      // traversal entry did NOT escape to the parent
      await expect(stat(join(dir, "escape.txt"))).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("assertWithinRoot", () => {
  test("accepts paths inside the root", () => {
    const root = join(tmpdir(), "workspace")
    expect(assertWithinRoot(root, join(root, "a.txt"), join(root, "sub", "b.txt"))).toBeNull()
  })

  test("rejects a path that escapes the root via ..", () => {
    const root = join(tmpdir(), "workspace")
    const res = assertWithinRoot(root, join(root, "..", "secret.txt"))
    expect(res?.ok).toBe(false)
    expect(res?.error).toBeTruthy()
  })

  test("rejects an absolute path outside the root", () => {
    const root = join(tmpdir(), "workspace")
    const res = assertWithinRoot(root, "/etc/passwd")
    expect(res?.ok).toBe(false)
  })

  test("rejects when any one of several paths escapes", () => {
    const root = join(tmpdir(), "workspace")
    const res = assertWithinRoot(root, join(root, "ok.txt"), join(root, "..", "..", "escape"))
    expect(res?.ok).toBe(false)
  })
})

describe("rename path guard (cwd ≠ workspace root)", () => {
  // The desktop main process calls process.chdir(homedir()) on startup, so cwd is the user's home
  // directory, not the workspace. This block verifies that the rename path-check (assertWithinRoot
  // on the target only, not on the bare nextName) works correctly under that condition.

  test("assertWithinRoot passes for an absolute target inside root regardless of cwd", () => {
    const originalCwd = process.cwd()
    process.chdir(homedir())
    try {
      const root = join(tmpdir(), "workspace")
      const target = join(root, "src", "old.txt")
      expect(assertWithinRoot(root, target)).toBeNull()
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("assertWithinRoot rejects a bare filename when cwd is outside root — why rename must not guard nextName", () => {
    const originalCwd = process.cwd()
    process.chdir(homedir())
    try {
      const root = join(tmpdir(), "workspace")
      // A bare filename resolves against cwd (homedir), not root, so it always escapes.
      // This is exactly why file-ops-rename guards only the target, never nextName.
      expect(assertWithinRoot(root, "renamed.txt")?.ok).toBe(false)
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("renamePath succeeds with a bare filename when cwd is outside the workspace", async () => {
    const originalCwd = process.cwd()
    process.chdir(homedir())
    const dir = await tmpDir()
    try {
      const file = join(dir, "old.txt")
      await writeText(file, "content")
      const res = await renamePath(file, "new.txt")
      expect(res.ok).toBe(true)
      expect(await readFile(join(dir, "new.txt"), "utf8")).toBe("content")
      await expect(stat(file)).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
      process.chdir(originalCwd)
    }
  })
})

describe("guardFileOpCall (IPC guard strategy)", () => {
  // Mirrors the ipc.ts file-ops handlers. The generic `fileOp` wrapper passes every string arg to
  // guardFileOpCall; `rename` passes only [target]. This block locks in WHY rename must not guard
  // nextName: nextName is a bare filename that resolves against cwd (homedir in the desktop main
  // process), so guarding it would always reject and break rename entirely.

  test("generic guard accepts all string args inside root", () => {
    const root = join(tmpdir(), "workspace")
    expect(guardFileOpCall(root, [join(root, "a.txt"), join(root, "sub", "b.txt")])).toBeNull()
  })

  test("generic guard rejects any arg escaping root", () => {
    const root = join(tmpdir(), "workspace")
    expect(guardFileOpCall(root, [join(root, "ok.txt"), join(root, "..", "escape")])?.ok).toBe(false)
  })

  test("rename guards only target, never the bare nextName", () => {
    const root = join(tmpdir(), "workspace")
    const target = join(root, "src", "old.txt") // absolute, inside root
    const nextName = "renamed.txt" // bare filename, resolves against cwd (outside root)

    // target inside root → guard passes → renamePath would run
    expect(guardFileOpCall(root, [target])).toBeNull()
    // The trap: if nextName were wrongly guarded, it would be rejected (cwd is outside root).
    expect(guardFileOpCall(root, [nextName])?.ok).toBe(false)
  })

  test("rename end-to-end: guard passes on target, then renamePath succeeds with the bare name", async () => {
    // Reproduces the ipc.ts rename handler's full flow:
    //   guardFileOpCall(root, [target]) → renamePath(target, nextName)
    // cwd is homedir (set by the desktop main process), proving the bare nextName works despite
    // cwd ≠ root — which is exactly why nextName must be excluded from the guard.
    const originalCwd = process.cwd()
    process.chdir(homedir())
    const dir = await tmpDir()
    try {
      const root = dir
      const target = join(root, "old.txt")
      await writeText(target, "content")
      const nextName = "new.txt"

      const guard = guardFileOpCall(root, [target])
      expect(guard).toBeNull()
      const res = guard ? guard : await renamePath(target, nextName)
      expect(res.ok).toBe(true)
      expect(await readFile(join(root, "new.txt"), "utf8")).toBe("content")
      await expect(stat(target)).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
      process.chdir(originalCwd)
    }
  })
})
