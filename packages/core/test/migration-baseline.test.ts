import { expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

test("migration generation rejects a deleted or stale schema baseline before diffing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deepagent-migration-baseline-"))
  const core = path.join(root, "packages/core")
  const old = path.join(core, "migration/20260101000000_old")
  const latest = path.join(core, "migration/20260201000000_latest")
  try {
    await fs.mkdir(path.join(core, "script"), { recursive: true })
    await fs.mkdir(old, { recursive: true })
    await fs.mkdir(latest, { recursive: true })
    await fs.copyFile(path.join(import.meta.dirname, "../script/migration.ts"), path.join(core, "script/migration.ts"))
    await Bun.write(path.join(latest, "migration.sql"), "SELECT 1;")
    await Bun.write(path.join(core, "migration/schema-baseline"), "20260201000000_latest/snapshot.json\n")
    await Bun.write(path.join(old, "snapshot.json"), "{}")

    const stale = Bun.spawnSync({ cmd: [process.execPath, "script/migration.ts"], cwd: core })
    expect(stale.exitCode).not.toBe(0)
    expect(stale.stderr.toString()).toContain("snapshot baseline does not match schema-baseline")

    await fs.rm(path.join(old, "snapshot.json"))
    const missing = Bun.spawnSync({ cmd: [process.execPath, "script/migration.ts"], cwd: core })
    expect(missing.exitCode).not.toBe(0)
    expect(missing.stderr.toString()).toContain("no snapshot.json baseline")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
