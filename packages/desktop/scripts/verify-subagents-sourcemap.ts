#!/usr/bin/env bun
import { strict as assert } from "node:assert"
import { basename, resolve } from "node:path"
import { generatedPositionFor, LEAST_UPPER_BOUND, originalPositionFor, TraceMap } from "@jridgewell/trace-mapping"

const assets = resolve("out/renderer/assets")
const maps = await Array.fromAsync(new Bun.Glob("*.js.map").scan({ cwd: assets, absolute: true }))
const target = "side-panel-subagents.tsx"
const candidates = (
  await Promise.all(
    maps.map(async (path) => {
      const raw = (await Bun.file(path).json()) as { sources?: string[]; sourcesContent?: Array<string | null> }
      const index = raw.sources?.findIndex((source) => source.endsWith(target)) ?? -1
      return index === -1 ? undefined : { path, raw, index }
    }),
  )
).filter((item) => item !== undefined)

assert.equal(candidates.length, 1, `expected one production source map for ${target}, found ${candidates.length}`)
const candidate = candidates[0]
const source = candidate.raw.sources?.[candidate.index]
const content = candidate.raw.sourcesContent?.[candidate.index]
assert(source, `source entry missing from ${candidate.path}`)
assert(content, `sourcesContent entry missing from ${candidate.path}`)
assert.equal(
  content,
  await Bun.file(resolve("../app/src/pages/session/side-panel-subagents.tsx")).text(),
  "production source map contains stale component source",
)

const originalLine = content.split("\n").findIndex((line) => line.includes("export const SidePanelSubagents")) + 1
assert(originalLine > 0, "SidePanelSubagents declaration missing from embedded source")

const map = new TraceMap(await Bun.file(candidate.path).text())
const generated = generatedPositionFor(map, {
  source,
  line: originalLine,
  column: 0,
  bias: LEAST_UPPER_BOUND,
})
assert(generated.line !== null && generated.column !== null, "component declaration has no generated mapping")

const stack = `at SidePanelSubagents (${basename(candidate.path, ".map")}:${generated.line}:${generated.column + 1})`
const frame = stack.match(/\((.+):(\d+):(\d+)\)$/)
assert(frame, `could not parse generated stack frame: ${stack}`)
const original = originalPositionFor(map, {
  line: Number(frame[2]),
  column: Number(frame[3]) - 1,
})
assert(original.source?.endsWith(target), `stack mapped to unexpected source: ${original.source}`)
assert.equal(original.line, originalLine, `stack mapped to line ${original.line}, expected ${originalLine}`)

console.log(`${stack} -> ${original.source}:${original.line}:${(original.column ?? 0) + 1}`)
