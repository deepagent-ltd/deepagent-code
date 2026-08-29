#!/usr/bin/env bun
// REL gate helper: extract a provider API key from the local deepagent-code auth.json into a
// permission-restricted key file consumable by the live-LLM harness
// (DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE). NEVER prints key material — only paths and byte counts.
//
// Usage: bun script/live-llm-key-from-auth.ts [provider]   (default: deepseek)
import { chmod, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const provider = process.argv[2] ?? "deepseek"
const authPath = path.join(os.homedir(), ".deepagent", "code", "auth.json")

const auth = (await Bun.file(authPath)
  .json()
  .catch(() => undefined)) as Record<string, { key?: string }> | undefined
if (!auth) {
  console.error(`unable to read ${authPath}`)
  process.exit(1)
}
const entry = auth[provider]
if (!entry?.key || typeof entry.key !== "string" || entry.key.length === 0) {
  console.error(`no key for provider "${provider}" in ${authPath} (available: ${Object.keys(auth).join(", ")})`)
  process.exit(1)
}

const outDir = path.join(os.homedir(), ".deepagent", "code", "tmp")
await mkdir(outDir, { recursive: true })
const outFile = path.join(outDir, `live-llm-${provider}.key`)
await Bun.write(outFile, `${entry.key.trim()}\n`)
await chmod(outFile, 0o600)
console.log(`wrote ${outFile} (bytes=${entry.key.trim().length}, mode=600)`)
console.log(`export DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE="${outFile}"`)
