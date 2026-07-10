#!/usr/bin/env bun
import { $ } from "bun"
import { readdir, rm } from "node:fs/promises"

import { resolveChannel } from "./utils"

const channel = resolveChannel()
await rm("out", { recursive: true, force: true })
await rm("resources/icons", { recursive: true, force: true })
await Promise.all(
  (await readdir("resources").catch(() => []))
    .filter((file) => file.endsWith(".metainfo.xml"))
    .map((file) => rm(`resources/${file}`, { force: true })),
)
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

await $`cd ../deepagent-code && bun script/build-node.ts`
