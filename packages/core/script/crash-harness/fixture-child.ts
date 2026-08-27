// C0-04 - fixture child for crash scenarios. Production-free; used ONLY by the
// harness tests. Sequence: write BEGIN marker (fsync) -> print HARNESS_READY ->
// sleep (kill window 'before commit') -> insert+commit row -> print
// HARNESS_COMMITTED -> sleep (kill window 'after commit') -> write DONE marker
// (fsync) -> print HARNESS_DONE -> exit.
// Usage: bun run fixture-child.ts -- <dbPath> <markersDir> [--crash-mode]

import { mkdirSync, writeFileSync, fsyncSync, openSync, closeSync } from "node:fs"
import { join } from "node:path"
import { Database } from "bun:sqlite"

function mark(dir: string, name: string): void {
  const path = join(dir, name)
  const fd = openSync(path, "w")
  writeFileSync(fd, "marker:" + name)
  fsyncSync(fd)
  closeSync(fd)
}

const args = process.argv.slice(2)
const dbPath = args[0]!
const markersDir = args[1]!
mkdirSync(markersDir, { recursive: true })
// Kill-window sleep. Default 5000ms (race-free kill window); tests set a short value for full runs.
const sleepMs = Number(process.env.CRASH_SLEEP_MS ?? "5000")

mark(markersDir, "begin")
console.log("HARNESS_READY")
await Bun.sleep(sleepMs) // kill window BEFORE commit (child prints READY then waits)

const db = new Database(dbPath, { create: true })
db.run("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
db.run("INSERT INTO state (key, value) VALUES ('flow','committed') ON CONFLICT(key) DO UPDATE SET value=excluded.value")
console.log("HARNESS_COMMITTED")
await Bun.sleep(sleepMs) // kill window AFTER commit, BEFORE done marker

mark(markersDir, "done")
db.close()
console.log("HARNESS_DONE")
