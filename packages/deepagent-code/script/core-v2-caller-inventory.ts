#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import ts from "typescript"

export const CALLER_INVENTORY_QUERY_ID = "core-v2-caller-inventory"
export const CALLER_INVENTORY_QUERY_VERSION = 1

// The legacy orchestration authority symbol whose production callers form the denominator that
// LEGACY-EXECUTION-ZERO must clear. Symbol scanning is the discovery mechanism only; the pinned
// classification below is the completion evidence (§8 of the migration plan).
const LEGACY_ORCHESTRATION_SYMBOL = "SessionPrompt"

export type CallerCategory =
  | "admission_control"
  | "orchestration"
  | "child_execution"
  | "recovery_compaction_context"
  | "projection_permission"
  | "composition_compat"
  | "unclassified"

export type CallerEntry = {
  readonly path: string
  readonly category: CallerCategory
  readonly references: number
}

export type CallerInventory = {
  readonly query_id: typeof CALLER_INVENTORY_QUERY_ID
  readonly query_version: number
  readonly legacy_symbol: string
  readonly entries: readonly CallerEntry[]
  readonly counts: Readonly<Record<CallerCategory, number>>
  readonly unclassified: number
  readonly result_sha256: string
}

const sourceRoots = ["packages/core/src", "packages/deepagent-code/src"]

export function scanCallerInventory(root: string): CallerInventory {
  const entries = sourceRoots
    .flatMap((sourceRoot) => collectSourceFiles(resolve(root, sourceRoot), root))
    .map((path) => ({ path, text: readFileSync(resolve(root, path), "utf8") }))
    .filter(({ text }) => text.includes(LEGACY_ORCHESTRATION_SYMBOL))
    .map(({ path, text }) => ({ path, references: countCodeReferences(path, text) }))
    .filter((entry): entry is { path: string; references: number } => entry.references > 0)
    .map(({ path, references }): CallerEntry => ({ path, category: classifyCaller(path), references }))
    .toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const counts = Object.fromEntries(
    (
      [
        "admission_control",
        "orchestration",
        "child_execution",
        "recovery_compaction_context",
        "projection_permission",
        "composition_compat",
        "unclassified",
      ] as const
    ).map((category) => [category, entries.filter((entry) => entry.category === category).length]),
  ) as Record<CallerCategory, number>
  return {
    query_id: CALLER_INVENTORY_QUERY_ID,
    query_version: CALLER_INVENTORY_QUERY_VERSION,
    legacy_symbol: LEGACY_ORCHESTRATION_SYMBOL,
    entries,
    counts,
    unclassified: counts.unclassified,
    result_sha256: createHash("sha256").update(canonicalJson(entries)).digest("hex"),
  }
}

// §8 categories. Rules are explicit and ordered; any caller that matches none of them stays
// `unclassified` and fails the gate, so new legacy call surface can never enter silently.
export function classifyCaller(path: string): CallerCategory {
  if (
    path.startsWith("packages/deepagent-code/src/server/") ||
    path.startsWith("packages/deepagent-code/src/im/") ||
    path.startsWith("packages/core/src/im/") ||
    path.endsWith("/cli/cmd/github.handler.ts")
  )
    return "admission_control"
  if (
    path === "packages/deepagent-code/src/session/prompt.ts" ||
    path === "packages/deepagent-code/src/session/processor.ts" ||
    path === "packages/deepagent-code/src/session/session.ts" ||
    path === "packages/deepagent-code/src/session/steer.ts"
  )
    return "orchestration"
  if (
    path === "packages/deepagent-code/src/session/task-executor.ts" ||
    path === "packages/deepagent-code/src/session/task-input.ts" ||
    path === "packages/deepagent-code/src/tool/task.ts" ||
    path === "packages/deepagent-code/src/session/goal-manager.ts" ||
    path === "packages/deepagent-code/src/session/goal-loop-wiring.ts" ||
    path === "packages/deepagent-code/src/session/goal-tick-port.ts" ||
    path === "packages/deepagent-code/src/session/facade-activity.ts" ||
    path === "packages/core/src/deepagent/goal-loop.ts"
  )
    return "child_execution"
  if (
    path.startsWith("packages/deepagent-code/src/session/prompt-epoch") ||
    path === "packages/deepagent-code/src/session/compaction.ts" ||
    path === "packages/deepagent-code/src/session/run-state.ts" ||
    path === "packages/deepagent-code/src/session/turn-deadline-watchdog.ts" ||
    path === "packages/deepagent-code/src/session/legacy-provider-resolution.ts" ||
    path === "packages/deepagent-code/src/session/recovery-transfer-guard.ts" ||
    path === "packages/deepagent-code/src/session/goal-governance-audit.ts" ||
    path === "packages/deepagent-code/src/context-federation/session-context-runtime.ts"
  )
    return "recovery_compaction_context"
  if (
    path === "packages/deepagent-code/src/session/message-v2.ts" ||
    path === "packages/deepagent-code/src/session/diff-artifact.ts" ||
    path === "packages/deepagent-code/src/session/prompt-intent.ts" ||
    path === "packages/deepagent-code/src/session/v4-event-runtime.ts" ||
    path === "packages/deepagent-code/src/permission/index.ts"
  )
    return "projection_permission"
  if (
    path.startsWith("packages/deepagent-code/src/effect/") ||
    path === "packages/core/src/session/sql.ts" ||
    path === "packages/core/src/session/runner/llm.ts" ||
    path.startsWith("packages/core/src/database/migration/")
  )
    return "composition_compat"
  return "unclassified"
}

function collectSourceFiles(dir: string, root: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const absolute = join(dir, name)
    if (!statSync(absolute).isDirectory()) {
      const rel = relative(root, absolute).split(sep).join("/")
      return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [rel] : []
    }
    if (name === "test" || name === "fixture" || name === "script" || name === "__tests__") return []
    return collectSourceFiles(absolute, root)
  })
}

export function canonicalJson(input: unknown): string {
  return JSON.stringify(normalize(input))
}

function normalize(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(normalize)
  if (!input || typeof input !== "object") return input
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, value]) => [key, normalize(value)]),
  )
}

// Comment and string-literal mentions are prose, not call surface: the denominator must only
// count code references so completion does not depend on rewriting comments, and renamed V2
// symbols (`SessionPromptIntent`, `SessionPromptEpoch*`) never enter the legacy denominator.
// Counting exact identifiers over the TypeScript AST is precise by construction, matching the
// discovery pattern used by the caller-surface regression gate.
function countCodeReferences(path: string, text: string): number {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  let count = 0
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === LEGACY_ORCHESTRATION_SYMBOL) count += 1
    node.forEachChild(visit)
  }
  visit(source)
  return count
}

function option(args: readonly string[], name: string) {
  const index = args.indexOf(name)
  if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}`)
  return args[index + 1]
}

function main() {
  const args = process.argv.slice(2)
  const root = resolve(option(args, "--root"))
  if (!isAbsolute(root)) throw new Error("root must be absolute")
  const inventory = scanCallerInventory(root)
  console.log(JSON.stringify(inventory, null, 2))
  process.exitCode = inventory.unclassified === 0 ? 0 : 1
}

if (import.meta.main) main()
