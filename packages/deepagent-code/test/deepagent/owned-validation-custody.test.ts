import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("owned validation retains unknown custody within its original 128-slot admission bound", async () => {
  if (process.platform !== "darwin" && process.platform !== "linux") return
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-owned-custody-"))
  try {
    const proc = Bun.spawn([process.execPath, "run", path.join(import.meta.dir, "fixture/owned-validation-custody-case.ts")], {
      cwd: directory, stdout: "pipe", stderr: "pipe", env: { ...process.env,
        XDG_CONFIG_HOME: path.join(directory, "config"), XDG_DATA_HOME: path.join(directory, "data"),
        XDG_CACHE_HOME: path.join(directory, "cache"), XDG_STATE_HOME: path.join(directory, "state") },
    })
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    expect({ code, err }).toEqual({ code: 0, err: "" })
    expect(JSON.parse(out)).toMatchObject({ unknownQuarantine: 1, sharedLimit: 128, replayRefused: true,
      unusedHandlesReleased: 127, scopeCannotReleaseUnknown: true, originalReceiptPreserved: true, nativeTreeProofClaimed: false })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 20_000)
