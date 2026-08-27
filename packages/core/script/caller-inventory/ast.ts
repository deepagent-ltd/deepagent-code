/**
 * AST utilities on the TypeScript Compiler API.
 *
 * All extraction runs on real ASTs, never text scans: comments and string
 * template literals are structurally invisible to these helpers, which is what
 * keeps the caller denominator pollution-free (worklist.md §4 C0-01).
 */
import ts from "typescript"
import { readdirSync, readFileSync } from "node:fs"

/** Cached parse of one source file plus its import bindings. */
export type ImportBinding = {
  readonly specifier: string
  readonly line: number
}

export type ParsedModule = {
  readonly file: string
  readonly sourceFile: ts.SourceFile
  /** localName -> binding (specifier + import statement line) */
  readonly imports: ReadonlyMap<string, ImportBinding>
  /** importedSymbol -> referenced at [line] (identifier references only) */
  readonly refLines: ReadonlyMap<string, number[]>
}

const cache = new Map<string, ParsedModule>()

export function rootRepoPath(): string {
  return new URL("../../../..", import.meta.url).pathname.replace(/\/$/, "")
}

export function isExcludedModule(repoPath: string): boolean {
  const p = repoPath.replaceAll("\\", "/")
  if (!/\.(ts|tsx)$/.test(p)) return true
  return (
    /(^|\/)(__tests__|test|tests|fixtures?)(\/|$)/.test(p) ||
    /\.(test|spec|d)\.(ts|tsx)$/.test(p)
  )
}

function collectRefs(sourceFile: ts.SourceFile): Map<string, number[]> {
  const refs = new Map<string, number[]>()
  const lineOf = (n: ts.Node) => sourceFile.getLineAndCharacterOfPosition(n.getStart()).line + 1

  // Flatten property-access chains to a dotted head-symbol key: SessionInput.admit → both
  // "SessionInput" and "SessionInput.admit". Head symbol must be a plain identifier so
  // occurrences inside strings/comments can never match.
  const record = (text: string, line: number) => {
    const lines = refs.get(text)
    if (lines) lines.push(line)
    else refs.set(text, [line])
  }

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      let chain = node.name.text
      let cursor: ts.Expression = node.expression
      while (true) {
        if (ts.isIdentifier(cursor)) {
          record(cursor.text, lineOf(node))
          record(`${cursor.text}.${chain}`, lineOf(node))
          break
        }
        if (ts.isPropertyAccessExpression(cursor)) {
          chain = `${cursor.name.text}.${chain}`
          cursor = cursor.expression
          continue
        }
        break
      }
    }
    if (ts.isIdentifier(node)) record(node.text, lineOf(node))
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return refs
}

/**
 * Chain keys recorded for one subtree only (same flattening convention as module refs:
 * bare identifier plus dotted head-rooted property chains). Comments and string literals
 * are AST nodes of other kinds and can never contribute keys.
 */
export function refsInSubtree(sourceFile: ts.SourceFile, root: ts.Node): Map<string, number[]> {
  const refs = new Map<string, number[]>()
  const lineOf = (n: ts.Node) => sourceFile.getLineAndCharacterOfPosition(n.getStart()).line + 1
  const record = (text: string, line: number) => {
    const lines = refs.get(text)
    if (lines) lines.push(line)
    else refs.set(text, [line])
  }
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      let chain = node.name.text
      let cursor: ts.Expression = node.expression
      while (true) {
        if (ts.isIdentifier(cursor)) {
          record(cursor.text, lineOf(node))
          record(`${cursor.text}.${chain}`, lineOf(node))
          break
        }
        if (ts.isPropertyAccessExpression(cursor)) {
          chain = `${cursor.name.text}.${chain}`
          cursor = cursor.expression
          continue
        }
        break
      }
    }
    if (ts.isIdentifier(node)) record(node.text, lineOf(node))
    ts.forEachChild(node, visit)
  }
  visit(root)
  return refs
}

/** All top-level (and nested function) declaration nodes bound to this exact name in the file. */
export function declarationNodes(mod: ParsedModule, name: string): readonly ts.Node[] {
  const found: ts.Node[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name?.text === name
    ) {
      found.push(node)
      return
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) {
          found.push(decl.initializer)
          return
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(mod.sourceFile)
  return found
}

export function parseModule(file: string): ParsedModule {
  const cached = cache.get(file)
  if (cached) return cached
  const text = readFileSync(file, "utf8")
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const imports = new Map<string, ImportBinding>()
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue
    const specifier = statement.moduleSpecifier.getText(sf).slice(1, -1)
    const line = sf.getLineAndCharacterOfPosition(statement.getStart()).line + 1
    if (statement.importClause.name) imports.set(statement.importClause.name.text, { specifier, line })
    const named = statement.importClause.namedBindings
    if (named && ts.isNamedImports(named)) {
      for (const el of named.elements) imports.set(el.name.text, { specifier, line })
    }
  }
  const parsed: ParsedModule = {
    file,
    sourceFile: sf,
    imports,
    refLines: collectRefs(sf),
  }
  cache.set(file, parsed)
  return parsed
}

/** All .ts/.tsx files under a directory (non-recursive with recurse=false). */
export function listSourceFiles(dir: string, recurse: boolean): string[] {
  const out: string[] = []
  const walk = (path: string) => {
    let entries
    try {
      entries = readdirSync(path, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = `${path}/${e.name}`
      if (e.isDirectory()) {
        if (recurse && !isExcludedModule(full)) walk(full)
        continue
      }
      if (isExcludedModule(full)) continue
      out.push(full)
    }
  }
  walk(dir)
  return out.sort()
}

export type CallSite = {
  readonly member: string
  readonly args: readonly string[]
  readonly node: ts.CallExpression
}

/** Calls of shape <anything>.member(...) collected from one parsed module. */
export function memberCalls(mod: ParsedModule, members: readonly string[]): CallSite[] {
  const wanted = new Set(members)
  const sites: CallSite[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      if (wanted.has(node.expression.name.text)) {
        sites.push({
          member: node.expression.name.text,
          args: node.arguments.map((a) => a.getText(mod.sourceFile)),
          node,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(mod.sourceFile)
  return sites
}

export function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart()).line + 1
}

/** Line of the first occurrence where `name` is referenced as an AST identifier. */
export function identifierLine(mod: ParsedModule, name: string): number | undefined {
  const lines = mod.refLines.get(name)
  return lines ? Math.min(...lines) : undefined
}

/** Line of a top-level class/function/variable declaration with this exact bound name. */
export function declarationLine(mod: ParsedModule, name: string): number | undefined {
  const sf = mod.sourceFile
  let found: number | undefined
  const visit = (node: ts.Node): void => {
    if (found) return
    if (
      (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name?.text === name
    ) {
      found = lineOf(sf, node)
      return
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name) {
          found = lineOf(sf, node)
          return
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

/** Line of the module self-export statement (`export * as X from "./x"`). */
export function selfExportLine(mod: ParsedModule): number | undefined {
  for (const statement of mod.sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) continue
    if (!statement.exportClause || !ts.isNamespaceExport(statement.exportClause)) continue
    if (!statement.moduleSpecifier) continue
    return lineOf(mod.sourceFile, statement)
  }
  return undefined
}

/**
 * Stable anchor line identifying a service module: named main declaration when
 * present, else the self-export namespace statement. Deterministic and AST-based.
 */
export function moduleAnchorLine(mod: ParsedModule, preferredName?: string): number {
  const declared = preferredName ? declarationLine(mod, preferredName) : undefined
  if (declared !== undefined) return declared
  const selfExport = selfExportLine(mod)
  if (selfExport !== undefined) return selfExport
  // NEW-P3-E: never fall back to synthetic line 1 (which only proves the file exists). Anchor to the
  // module's first real top-level declaration/export so the cited line is a genuine AST fact.
  for (const statement of mod.sourceFile.statements) {
    if (statement.getStart() < 0) continue
    if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) continue
    return lineOf(mod.sourceFile, statement)
  }
  return 1
}
