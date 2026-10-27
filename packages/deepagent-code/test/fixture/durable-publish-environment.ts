import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Exit } from "effect"
import { DurablePublish } from "@deepagent-code/core/database/durable-publish"

const root = await fs.realpath(process.argv[2]!)
assert.equal(process.platform, "win32")
assert.equal(path.win32.parse(root).root.toUpperCase(), "D:\\")
const source = path.join(root, "source.tmp")
const target = path.join(root, "target.db")
const bytes = Buffer.alloc(1024, 0x5a)
await fs.writeFile(source, bytes, { flag: "wx", mode: 0o600 })
await fs.writeFile(path.join(root, "ready.json.tmp"), JSON.stringify({ phase: "ready", pid: process.pid }))
await fs.rename(path.join(root, "ready.json.tmp"), path.join(root, "ready.json"))
console.info("DURABLE_PUBLISH_ENV_PHASE", JSON.stringify({ phase: "ready" }))
assert.equal(await Bun.stdin.text(), "GO\n")
const started = performance.now()
console.info("DURABLE_PUBLISH_ENV_PHASE", JSON.stringify({ phase: "bridge-start" }))
// This is the original bridge, including its 30s watchdog and nonce receipt.
const result = await Effect.runPromiseExit(DurablePublish.windows(source, target, false))
const receipt = {
  pid: process.pid,
  bridgeReceipt: Exit.isSuccess(result),
  sourceGone: !(await fs.exists(source)),
  targetEqual: await fs.readFile(target).then((value) => value.equals(bytes), () => false),
  elapsedMs: Math.round(performance.now() - started),
}
await fs.writeFile(path.join(root, "result.json"), JSON.stringify(receipt), { flag: "wx", mode: 0o600 })
console.info("DURABLE_PUBLISH_ENV_PHASE", JSON.stringify({ phase: "bridge-returned", elapsedMs: receipt.elapsedMs }))
process.exitCode = receipt.bridgeReceipt && receipt.sourceGone && receipt.targetEqual ? 0 : 2
