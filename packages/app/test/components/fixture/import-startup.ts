import { appendFileSync } from "node:fs"
import path from "node:path"

// Preload runs before the server's transitive imports, so startup failures retain a phase.
appendFileSync(path.join(process.argv[2]!, "startup.jsonl"), JSON.stringify({
  phase: "bun-preload-entered",
  elapsedMs: performance.now(),
  pid: process.pid,
  platform: process.platform,
  systemRootPresent: Boolean(process.env.SystemRoot ?? process.env.SYSTEMROOT),
}) + "\n", { mode: 0o600 })
