import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { writeSync } from "node:fs"
import { Global } from "@deepagent-code/core/global"
import { MediaFileTrace } from "./kernel-media-file-trace"

/** Optional QA-only FD observer for the unchanged Server.listen fixture.
 * It never wraps an SDK Effect, reader request, result, error or deadline. */
export async function install(root: string) {
  assert(root.startsWith("/tmp/dac-im-media-product-") && ["A", "B"].includes(path.basename(root)))
  const file = await fs.open(path.join(root, "media-fs-safe.jsonl"), "wx", 0o600)
  const count = { value: 0 }
  const samples: Record<string, number> = {}
  const files = MediaFileTrace.install(await fs.realpath(Global.Path.data), (fact) => {
    const key = `${fact.operation}:${fact.phase}`
    samples[key] = (samples[key] ?? 0) + 1
    if (["lstat", "realpath"].includes(fact.operation) && samples[key] > 4 && samples[key] % 100 !== 0) return
    if (count.value++ >= 4096) return
    try { writeSync(file.fd, JSON.stringify({ ...fact, count: samples[key], at: Date.now() }) + "\n") } catch {}
  })
  return async () => {
    files.restore()
    await fs.writeFile(path.join(root, "media-fs-counts-safe.json"), JSON.stringify({ counts: files.counts, eventCount: Math.min(count.value, 4096), truncated: count.value > 4096 }), { mode: 0o600 }).catch(() => {})
    await file.close().catch(() => {})
  }
}

export * as OriginalMediaFileTrace from "./kernel-media-original-file-trace"
