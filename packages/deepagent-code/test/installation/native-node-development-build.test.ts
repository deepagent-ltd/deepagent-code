import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { prepare, build, readEvidence } from "./fixture/native-node-development-build"

test("ordinary Node development build needs no Cargo or publisher and removes stale Native metadata", async () => {
  const replay = process.env.DAC_NATIVE_NODE_DEVELOPMENT_REPLAY
    ? await readEvidence(process.env.DAC_NATIVE_NODE_DEVELOPMENT_REPLAY)
    : undefined
  const input = replay?.input ?? await prepare()
  process.stderr.write(`NATIVE_NODE_DEVELOPMENT_EVIDENCE ${input.root}\n`)
  const result = replay ? replay.result : await build(input)
  expect(result.code).toBe(0)
  expect(result.logs).toContain("Build complete")
  const required = [
    "NOTICE", "auth-password-worker.node.js", "auth-password-worker.node.js.map", "node.js", "node.js.map",
  ]
  expect(required.every((file) => result.outputs.includes(file))).toBe(true)
  expect(result.outputs.every((file) => required.includes(file) || file.endsWith(".wasm"))).toBe(true)
  for (const file of result.outputs.filter((file) => file.endsWith(".wasm")))
    expect((await fs.readFile(path.join(input.output, file))).subarray(0, 4)).toEqual(Buffer.from([0, 97, 115, 109]))
  expect(await fs.readFile(path.join(input.output, "NOTICE"))).toEqual(await fs.readFile(path.join(input.copy, "NOTICE")))
  const bundle = await Bun.file(path.join(input.output, "node.js")).text()
  expect(bundle).toContain('from "@lydell/node-pty"')
  expect(bundle).toContain('from "jsonc-parser"')
  expect(bundle).not.toContain(input.copy)
  expect(bundle).not.toContain('from "bun:')
  expect((await fs.stat(path.join(input.output, "auth-password-worker.node.js"))).size).toBeGreaterThan(0)
  const drift = []
  for (const entry of input.manifest) {
    if (createHash("sha256").update(await fs.readFile(path.join(input.copy, entry.path))).digest("hex") !== entry.sha256)
      drift.push(entry.path)
  }
  expect(drift).toEqual([])
  await fs.writeFile(path.join(input.root, "safe.json"), JSON.stringify({ version: 1,
    root: input.root, inputs: input.manifest.length, drift, outputs: result.outputs,
    noCargo: true, noPublisher: true, noNativeAssetsOrMetadata: true, provider: 0, database: 0, NativeExecution: 0,
    assertionReplay: Boolean(replay), newBuildsInReplay: 0,
    boundary: "actual original Node-targeted build on local Darwin ARM; not Windows/Desktop runtime or Native capability",
  }, null, 2), { mode: 0o600 })
}, 60_000)
