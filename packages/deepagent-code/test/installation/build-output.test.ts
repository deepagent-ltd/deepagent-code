import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { prepareBuildOutput } from "../../script/build-output"

test("default build preserves the exact prior candidate while private output rejects existing paths", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-build-output-")))
  try {
    await fs.mkdir(path.join(root, "dist"))
    await fs.writeFile(path.join(root, "dist/old-candidate"), "original candidate bytes")
    const next = await prepareBuildOutput(root, [])
    expect(next.output).toBe(path.join(root, "dist"))
    expect(await fs.readdir(next.output)).toEqual([])
    expect(await fs.readFile(path.join(next.previous!, "old-candidate"), "utf8")).toBe("original candidate bytes")
    const privateOutput = await prepareBuildOutput(root, ["--outdir", "private-new"])
    expect(privateOutput.previous).toBeUndefined()
    expect(await fs.readdir(privateOutput.output)).toEqual([])
    await expect(prepareBuildOutput(root, ["--outdir", "private-new"])).rejects.toThrow("does not exist")
    await expect(prepareBuildOutput(root, ["--outdir"])).rejects.toThrow("requires")
    await expect(prepareBuildOutput(root, ["--outdir", root])).rejects.toThrow("ancestor")
    await fs.symlink(next.previous!, path.join(root, "symlink"))
    await expect(prepareBuildOutput(root, ["--outdir", "symlink"])).rejects.toThrow("does not exist")
    expect(await fs.readFile(path.join(next.previous!, "old-candidate"), "utf8")).toBe("original candidate bytes")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
