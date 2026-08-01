import { CodeGraph } from "@deepagent-code/core/code-intelligence/code-graph"
import { Hash } from "@deepagent-code/core/util/hash"
import path from "node:path"
import ts from "typescript"
import type { File } from "../location-index/manifest"

const AdapterVersion = "ts-js-v1"
const TypeScriptExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"])

type SymbolRecord = {
  readonly node: ts.Node
  readonly source: ts.SourceFile
  readonly entity: CodeGraph.Entity
  readonly symbol: CodeGraph.Symbol
}

export function indexWorkspace(input: { readonly root: string; readonly files: readonly File[] }): CodeGraph.Build {
  const files = new Map(input.files.map((file) => [path.resolve(file.absolutePath), file]))
  const rootNames = [...files.keys()].filter((file) => TypeScriptExtensions.has(path.extname(file).toLowerCase()))
  const configuration = configurationFor(input.root, rootNames)
  const host = ts.createCompilerHost(configuration.options, true)
  const readFile = host.readFile
  const fileExists = host.fileExists
  host.fileExists = (fileName) => files.has(path.resolve(fileName)) || fileExists(fileName)
  host.readFile = (fileName) => files.get(path.resolve(fileName))?.content ?? readFile(fileName)
  const program = ts.createProgram({ rootNames, options: configuration.options, host })
  const checker = program.getTypeChecker()
  const projections = input.files.map((file) => fileProjection(file, semanticLanguage(file.path) ? "semantic" : "file"))
  const byPath = new Map(projections.map((projection) => [projection.file.path, projection]))
  const records = new Map<string, SymbolRecord>()

  for (const source of program.getSourceFiles()) {
    const file = files.get(path.resolve(source.fileName))
    if (!file) continue
    const projection = byPath.get(file.path)!
    const symbols = collectSymbols(source, file.path)
    symbols.forEach((record) => records.set(declarationKey(record.node), record))
    byPath.set(file.path, {
      ...projection,
      symbols: symbols.map((record) => ({ entity: record.entity, symbol: record.symbol })),
      edges: [
        ...symbols.map((record) => ({
          fromEntityId: projection.entity.entityId,
          toEntityId: record.entity.entityId,
          relation: "contains" as const,
          evidence: `${AdapterVersion}:ast`,
        })),
        ...symbols
          .filter((record) => hasExportModifier(record.node))
          .map((record) => ({
            fromEntityId: projection.entity.entityId,
            toEntityId: record.entity.entityId,
            relation: "exports" as const,
            evidence: `${AdapterVersion}:modifier`,
          })),
      ],
      file: { ...projection.file, semanticLevel: "semantic" },
    })
  }

  const externalEntities = new Map<string, CodeGraph.Entity>()
  const workspaceEdges: CodeGraph.Edge[] = []
  for (const source of program.getSourceFiles()) {
    const file = files.get(path.resolve(source.fileName))
    if (!file) continue
    const projection = byPath.get(file.path)!
    source.forEachChild((node) => {
      if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) return
      if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) return
      const specifier = node.moduleSpecifier.text
      const resolved = ts.resolveModuleName(specifier, source.fileName, configuration.options, host).resolvedModule
      const targetFile = resolved ? files.get(path.resolve(resolved.resolvedFileName)) : undefined
      const target = targetFile ? byPath.get(targetFile.path)?.entity : externalEntity(specifier)
      if (!target) return
      if (!targetFile) externalEntities.set(target.entityId, target)
      workspaceEdges.push({
        fromEntityId: projection.entity.entityId,
        toEntityId: target.entityId,
        relation:
          (ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly : node.isTypeOnly) ? "references" : "imports",
        evidence: `${AdapterVersion}:module-resolution:${specifier}`,
      })
    })
    walk(source, (node) => {
      if (!ts.isCallExpression(node)) return
      const caller = enclosingRecord(node, records)
      const observed = checker.getSymbolAtLocation(node.expression)
      const target = observed && observed.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(observed) : observed
      const declaration = target?.valueDeclaration ?? target?.declarations?.[0]
      const callee = declaration ? records.get(declarationKey(declaration)) : undefined
      if (!caller || !callee) return
      workspaceEdges.push({
        fromEntityId: caller.entity.entityId,
        toEntityId: callee.entity.entityId,
        relation: "calls",
        evidence: `${AdapterVersion}:type-checker`,
      })
    })
  }
  return {
    files: [...byPath.values()],
    externalEntities: [...externalEntities.values()],
    edges: dedupeEdges(workspaceEdges),
    aliases: [],
  }
}

export function fileProjection(file: File, semanticLevel: CodeGraph.SemanticLevel = "file"): CodeGraph.FileProjection {
  const entityId = fileEntityId(file.path)
  const language = languageOf(file.path)
  return {
    entity: {
      entityId,
      entityKind: "file",
      stableKey: `file/v1:${file.path}`,
      displayName: file.path,
      language,
      filePath: file.path,
      identityStability: "durable",
    },
    file: {
      entityId,
      path: file.path,
      language,
      contentSha: Hash.sha256(file.content),
      mtimeNs: file.mtimeNs,
      semanticLevel,
      searchableText: file.content.slice(0, 256 * 1024),
    },
    symbols: [],
    edges: [],
  }
}

export function fileEntityId(filePath: string) {
  return `code_file_${Hash.sha256(`file/v1:${filePath}`)}`
}

function configurationFor(root: string, rootNames: readonly string[]) {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json") ?? ts.findConfigFile(root, ts.sys.fileExists, "jsconfig.json")
  if (!configPath) {
    return {
      options: {
        allowJs: true,
        checkJs: false,
        jsx: ts.JsxEmit.Preserve,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2022,
      } satisfies ts.CompilerOptions,
    }
  }
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) return { options: {} satisfies ts.CompilerOptions }
  return ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath), undefined, configPath, undefined, [
    { extension: ".js", isMixedContent: false, scriptKind: ts.ScriptKind.JS },
    { extension: ".jsx", isMixedContent: false, scriptKind: ts.ScriptKind.JSX },
  ])
}

function collectSymbols(source: ts.SourceFile, filePath: string) {
  const records: SymbolRecord[] = []
  const overloads = new Map<string, number>()
  const visit = (node: ts.Node, parents: readonly string[]) => {
    const value = symbolName(node)
    const nextParents = value ? [...parents, value.name] : parents
    if (value) {
      const symbolPath = nextParents.join(".")
      const overload = overloads.get(`${value.kind}:${symbolPath}`) ?? 0
      overloads.set(`${value.kind}:${symbolPath}`, overload + 1)
      const entityId = `code_symbol_${Hash.sha256(`${AdapterVersion}:${filePath}:${symbolPath}:${value.kind}:${overload}`)}`
      const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      const end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1
      records.push({
        node,
        source,
        entity: {
          entityId,
          entityKind: "symbol",
          stableKey: `${AdapterVersion}:${fileEntityId(filePath)}:${symbolPath}:${value.kind}:${overload}`,
          displayName: value.name,
          language: languageOf(filePath),
          filePath,
          identityStability: value.durable ? "durable" : "generation",
        },
        symbol: {
          entityId,
          owningEntityId: fileEntityId(filePath),
          symbolPath,
          kind: value.kind,
          startLine: start,
          endLine: end,
          signature: signature(node, source),
        },
      })
    }
    node.forEachChild((child) => visit(child, nextParents))
  }
  source.forEachChild((node) => visit(node, []))
  return records
}

function symbolName(node: ts.Node) {
  if (
    ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
  ) {
    const name = node.name?.getText()
    if (!name) return
    return { name, kind: ts.SyntaxKind[node.kind].replace(/Declaration$/, "").toLowerCase(), durable: true }
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return { name: node.name.text, kind: "variable", durable: !isInsideFunction(node) }
  }
}

function signature(node: ts.Node, source: ts.SourceFile) {
  const text = node.getText(source).slice(0, 800)
  const brace = text.indexOf("{")
  return (brace === -1 ? text : text.slice(0, brace)).replace(/\s+/g, " ").trim().slice(0, 400)
}

function declarationKey(node: ts.Node) {
  return `${path.resolve(node.getSourceFile().fileName)}:${node.getStart(node.getSourceFile())}`
}

function enclosingRecord(node: ts.Node, records: ReadonlyMap<string, SymbolRecord>) {
  let current: ts.Node | undefined = node.parent
  while (current) {
    const record = records.get(declarationKey(current))
    if (record) return record
    current = current.parent
  }
}

function walk(node: ts.Node, use: (node: ts.Node) => void) {
  use(node)
  node.forEachChild((child) => walk(child, use))
}

function hasExportModifier(node: ts.Node) {
  return Boolean(ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export)
}

function isInsideFunction(node: ts.Node) {
  let current = node.parent
  while (current) {
    if (ts.isFunctionLike(current)) return true
    current = current.parent
  }
  return false
}

function externalEntity(specifier: string): CodeGraph.Entity {
  const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!
  return {
    entityId: `code_external_${Hash.sha256(`npm/v1:${packageName}`)}`,
    entityKind: "external_package",
    stableKey: `npm/v1:${packageName}`,
    displayName: packageName,
    language: "package",
    identityStability: "durable",
  }
}

function semanticLanguage(filePath: string) {
  return TypeScriptExtensions.has(path.extname(filePath).toLowerCase())
}

function languageOf(filePath: string) {
  return {
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".mts": "typescript",
    ".cts": "typescript",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".mjs": "javascript",
    ".cjs": "javascript",
  }[path.extname(filePath).toLowerCase()] ?? (path.extname(filePath).slice(1).toLowerCase() || "text")
}

function dedupeEdges(edges: readonly CodeGraph.Edge[]) {
  return [...new Map(edges.map((edge) => [JSON.stringify(edge), edge])).values()]
}
