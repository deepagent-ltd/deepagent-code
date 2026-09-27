#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { parseArgs } from "util"

const root = path.resolve(import.meta.dirname, "../../..")
const sqlDir = path.join(root, "packages/core/migration")
const baselinePin = path.join(sqlDir, "schema-baseline")
const tsDir = path.join(root, "packages/core/src/database/migration")
const registry = path.join(root, "packages/core/src/database/migration.gen.ts")
const args = parseArgs({
  args: process.argv.slice(2),
  options: {
    check: { type: "boolean" },
    name: { type: "string" },
    "registry-only": { type: "boolean" },
  },
})

if (args.values.check) {
  await check()
  process.exit(0)
}

if (args.values["registry-only"]) {
  await Bun.write(registry, await renderRegistry(await migrationNamesInRegistryOrder()))
  process.exit(0)
}

await assertBaselinePresent()

await $`bun drizzle-kit generate ${args.values.name ? ["--name", args.values.name] : []}`.cwd(
  path.join(root, "packages/core"),
)

const sqlMigrations = await sqlMigrationNames(sqlDir)

for (const name of sqlMigrations) {
  // Checkpoints seed Drizzle's next schema diff; executable backfills and triggers stay in the TypeScript migration chain.
  if (await isSchemaCheckpoint(sqlDir, name)) continue
  if (await Bun.file(path.join(tsDir, `${name}.ts`)).exists()) continue
  await Bun.write(
    path.join(tsDir, `${name}.ts`),
    renderMigration(name, await Bun.file(path.join(sqlDir, name, "migration.sql")).text()),
  )
}

const baseline = await pruneHistoricalSnapshots(sqlDir)
if (baseline) await Bun.write(baselinePin, `${path.relative(sqlDir, baseline)}\n`)

await Bun.write(registry, await renderRegistry(await migrationNamesInRegistryOrder()))

/**
 * Snapshot convention (X-14, user ruling 2026-09-23): only the NEWEST full-schema baseline
 * snapshot.json is committed. drizzle-kit diffs against the lexicographically-last snapshot
 * only, so historical snapshots are dead weight. Deleting the baseline instead would make
 * the next generate diff against the empty dry snapshot and emit a full-schema migration
 * (the duplicate-generation trap), so refuse to run on a tree that has migrations but no
 * baseline — restore the baseline from git history instead. schema-baseline pins the
 * expected path so a lone older snapshot cannot silently replace a deleted baseline.
 */
async function assertBaselinePresent() {
  const migrations = await sqlMigrationNames(sqlDir)
  if (migrations.length === 0) return
  const baseline = (await snapshotPaths(sqlDir)).at(-1)
  if (!baseline) {
    throw new Error(
      "packages/core/migration has SQL migrations but no snapshot.json baseline. " +
        "Regenerating now would duplicate the entire schema. Restore the newest baseline snapshot from git history " +
        "(the last committed snapshot.json) before running script/migration.ts.",
    )
  }
  const pinned = Bun.file(baselinePin)
  if (!(await pinned.exists()) || (await pinned.text()).trim() !== path.relative(sqlDir, baseline)) {
    throw new Error(
      "packages/core/migration snapshot baseline does not match schema-baseline. " +
        "Restore the pinned snapshot from git history before running script/migration.ts.",
    )
  }
}

/** Keep only the lexicographically-last (newest) snapshot as the committed baseline. */
async function pruneHistoricalSnapshots(directory: string) {
  const snapshots = await snapshotPaths(directory)
  const keep = snapshots.at(-1)
  for (const file of snapshots) {
    if (file === keep) continue
    await fs.rm(file)
    console.log(`Pruned historical schema snapshot: ${path.relative(root, file)}`)
  }
  return keep
}

async function snapshotPaths(directory: string) {
  return (await Array.fromAsync(new Bun.Glob("*/snapshot.json").scan({ cwd: directory })))
    .map((file) => path.join(directory, file))
    .sort()
}

async function check() {
  await assertBaselinePresent()
  const committed = await snapshotPaths(sqlDir)
  if (committed.length > 1) {
    throw new Error(
      `packages/core/migration commits ${committed.length} snapshot.json files; the convention keeps only the newest baseline. Run \`bun script/migration.ts\` from packages/core.`,
    )
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "deepagent-code-core-migration-check-"))
  const output = path.join(temporary, "migration")
  try {
    await fs.cp(sqlDir, output, { recursive: true })
    const config = path.join(temporary, "drizzle.config.ts")
    await Bun.write(
      config,
      `import config from ${JSON.stringify(pathToFileURL(path.join(root, "packages/core/drizzle.config.ts")).href)}

export default { ...config, out: ${JSON.stringify(output)} }
`,
    )
    const before = await snapshot(output)
    await $`bun drizzle-kit generate --config ${config}`.cwd(path.join(root, "packages/core"))
    const after = await snapshot(output)
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      throw new Error(
        "Core schema has ungenerated database migrations. Run `bun script/migration.ts` from packages/core.",
      )
    }

    const sqlMigrations = await sqlMigrationNames(output)
    for (const name of sqlMigrations) {
      if (await isSchemaCheckpoint(output, name)) continue
      if (await Bun.file(path.join(tsDir, `${name}.ts`)).exists()) continue
      throw new Error(
        `Database migration TypeScript wrapper is missing for ${name}. Run \`bun script/migration.ts\` from packages/core.`,
      )
    }
    if ((await Bun.file(registry).text()) !== (await renderRegistry(await migrationNamesInRegistryOrder()))) {
      throw new Error("Database migration registry is stale. Run `bun script/migration.ts` from packages/core.")
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

async function sqlMigrationNames(directory: string) {
  return (await Array.fromAsync(new Bun.Glob("*/migration.sql").scan({ cwd: directory })))
    .map((file) => file.split("/")[0])
    .filter((name) => name !== undefined)
    .sort()
}

function isSchemaCheckpoint(directory: string, name: string) {
  return Bun.file(path.join(directory, name, "schema-checkpoint")).exists()
}

async function typescriptMigrationNames() {
  return (await Array.fromAsync(new Bun.Glob("*.ts").scan({ cwd: tsDir }))).map((file) => file.slice(0, -3)).sort()
}

async function migrationNamesInRegistryOrder() {
  const available = await typescriptMigrationNames()
  const availableSet = new Set(available)
  const registered = Array.from((await Bun.file(registry).text()).matchAll(/import\("\.\/migration\/([^"]+)"\)/g))
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined && availableSet.has(name))
  const registeredSet = new Set(registered)
  return [...registered, ...available.filter((name) => !registeredSet.has(name))]
}

async function snapshot(directory: string) {
  const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: directory, onlyFiles: true }))
  return Promise.all(
    files.sort().map(async (file) => ({ path: file, contents: await Bun.file(path.join(directory, file)).text() })),
  )
}

function renderMigration(name: string, sql: string) {
  return `import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: ${JSON.stringify(name)},
  up(tx) {
    return Effect.gen(function* () {
${sql
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0)
  .map(renderRun)
  .join("\n")}
    })
  },
} satisfies DatabaseMigration.Migration
`
}

function renderRun(statement: string) {
  const lines = statement.replaceAll("\t", "  ").split("\n")
  if (lines.length === 1) return `      yield* tx.run(\`${escapeTemplate(lines[0])}\`)`
  return `      yield* tx.run(\`\n${lines.map((line) => `        ${escapeTemplate(line)}`).join("\n")}\n      \`)`
}

function escapeTemplate(line: string) {
  return line.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${")
}

async function renderRegistry(names: string[]) {
  const bodyHashes = await Promise.all(
    names.map(async (name) =>
      Bun.CryptoHasher.hash("sha256", await Bun.file(path.join(tsDir, `${name}.ts`)).arrayBuffer(), "hex"),
    ),
  )
  return `import type { DatabaseMigration } from "./migration"

const modules = await Promise.all([
${names.map((name) => `    import("./migration/${name}"),`).join("\n")}
])

const bodyHashes = [
${bodyHashes.map((hash) => `  ${JSON.stringify(hash)},`).join("\n")}
]

export const migrations = modules.map((module, index) => ({
  ...module.default,
  bodyHash: bodyHashes[index]!,
})) satisfies DatabaseMigration.Migration[]
`
}
