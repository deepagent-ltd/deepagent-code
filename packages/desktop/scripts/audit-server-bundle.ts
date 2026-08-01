#!/usr/bin/env bun

import { strict as assert } from "node:assert"
import { readdir } from "node:fs/promises"
import path from "node:path"

const chunks = path.resolve("out/main/chunks")
const sidecar = await Bun.file(path.resolve("out/main/sidecar.js")).text()
const server = Bun.file(path.join(chunks, "node.js"))
const sourceMap = Bun.file(path.join(chunks, "node.js.map"))
const files = await readdir(chunks)

assert.match(sidecar, /import\(["']\.\/chunks\/node\.js["']\)/, "sidecar must load the external server bundle")
assert.equal(await server.exists(), true, "external server bundle is missing")
assert.equal(await sourceMap.exists(), true, "external server source map is missing")
assert.deepEqual(
  files.filter((file) => /^node-.+\.js$/.test(file)),
  [],
  "Rollup must not emit a transformed copy of the server bundle",
)

const source = await server.text()
assert.match(source, /sourceMappingURL=node\.js\.map/, "external server bundle is not linked to its source map")
assert.equal(
  source.includes('from "@lydell/node-pty"'),
  true,
  "external server bundle does not use the packaged node-pty platform selector",
)
assert.equal(
  source.includes('from "jsonc-parser"') || source.includes("from 'jsonc-parser'"),
  true,
  "external server bundle does not declare its packaged jsonc-parser dependency",
)

console.log(`External server bundle verified: ${Math.ceil(server.size / 1024 / 1024)} MiB`)
