/**
 * C0-08 selection-bridge usage counter.
 *
 * A V2 provider turn that does NOT query the four federated graphs falls back to the legacy
 * `v2-none` graph-revision value (design.md §1 gap 3; worklist C3-05: a V2 attempt must never
 * carry `v2-none`). The bridge that copies legacy selection evidence into the V2 selection is a
 * legacy-authority leak the gate must drive to zero.
 *
 * This module counts the runtime `v2-none` string-literal usages in the production src tree
 * using the TypeScript AST, so comment/string-template prose is structurally invisible — the
 * same anti-pollution rule the C0-01 inventory applies. A V2 turn that commits a real four-graph
 * selection has zero such literals.
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import { rootRepoPath } from "../caller-inventory/ast"

/** One source site still committing the v2-none selection-bridge fallback. */
export type SelectionBridgeSite = {
  readonly repoFile: string
  readonly line: number
}

/** Directory that must not be walked into for the source scan. */
const EXCLUDED = /(^|\/)(node_modules|\.git|\.artifacts)(\/|$)/

/** Recursively collect .ts files under `dir`, skipping vendored/artifact dirs. */
function collectTsFiles(dir: string, out: string[]): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!EXCLUDED.test(full)) collectTsFiles(full, out)
      continue
    }
    if (/[.]ts$/.test(entry.name) && !/[.]d[.]ts$/.test(entry.name)) out.push(full)
  }
}

/**
 * Enumerate every production source site that commits the v2-none selection-bridge
 * fallback (a TS string literal with the text `v2-none`). Sites are in deterministic
 * file order. A clean V2 four-graph tree has zero sites.
 */
export function selectionBridgeSites(): readonly SelectionBridgeSite[] {
  const repoRoot = rootRepoPath()
  const srcDir = join(repoRoot, "packages", "core", "src")
  const files: string[] = []
  collectTsFiles(srcDir, files)
  const sites: SelectionBridgeSite[] = []
  for (const file of files.sort()) {
    const text = readFileSync(file, "utf8")
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) && node.text === "v2-none") {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1
        sites.push({ repoFile: file.slice(repoRoot.length + 1).replaceAll("\\", "/"), line })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return sites
}

/** Total count of runtime v2-none selection-bridge usages (zero = fully migrated). */
export function countSelectionBridgeUsages(sites: readonly SelectionBridgeSite[] = selectionBridgeSites()): number {
  return sites.length
}
