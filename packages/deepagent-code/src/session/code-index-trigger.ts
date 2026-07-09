import path from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Option } from "effect"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { DeepAgentCodeIndexer } from "@deepagent-code/core/deepagent/index"
import { LSP } from "@/lsp/lsp"

// V3.8 Phase 3 (v3.8.1 §B.3) — the code-indexer TRIGGER. code-indexer.ts (registerFile/indexFiles)
// was pure with ZERO production callers, so no `code_symbol` node ever reached the graph and
// GraphQuery/UnifiedContextGraph could never traverse into code. This module is the real trigger: on
// first prompt of a session it runs ONE lightweight, file-level index pass over the workspace and
// writes the nodes into the SAME per-project DurableKnowledgeStore instance that GraphQuery reads
// (via knowledge-source's cached projectStoreFor), so the nodes are immediately query-hittable.
//
// V3.9 §A (code-graph deepening) — the SYMBOL pass. After the file-level pass, an OPTIONAL AST-level
// pass runs LSP `documentSymbol` (+ callHierarchy where supported) over the files whose content-sha
// CHANGED this pass, extracting function/class/method-level symbol child nodes, file→file `imports`
// edges and symbol→symbol `calls` edges, then feeds them to the PURE core `indexSymbols` (core cannot
// import LSP — it is a lower layer — so extraction lives here). Everything degrades safely:
//   - no `lsp` provided, or a language with no LSP client / empty documentSymbol → file-level only,
//     identical to V3.8.1, no failure (§A.2/§A.5 "未配 LSP 的语言降级到文件级，不失败").
//   - only content-sha-changed files are LSP-extracted, capped by MAX_SYMBOL_FILES, so the first-prompt
//     async path stays bounded (§A.4 "仅对 content-sha 变化的文件跑 LSP，避免全量").
//   - content-sha gate in indexSymbols keeps re-indexing an unchanged file at ZERO new versions (§A.5).
//
// default-safe: everything is wrapped in Effect.matchCauseEffect so a walk/read/index/LSP failure
// spins the capability down (no nodes written) rather than crashing the session boot.

// Generous, intentionally-not-too-tight defaults (the task calls for a loose, configurable default).
// Overridable via env for operators who want to widen/narrow without a code change.
const numFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}
const MAX_FILES = () => numFromEnv("DEEPAGENT_CODE_INDEX_MAX_FILES", 5000)
const MAX_FILE_BYTES = () => numFromEnv("DEEPAGENT_CODE_INDEX_MAX_FILE_BYTES", 512 * 1024)
// V3.9 §A cost guards. The symbol pass runs LSP per file (documentSymbol) and per symbol
// (callHierarchy) — expensive on a first-prompt full index where EVERY file is "changed". Cap the
// number of files that get the AST pass and the total number of symbols probed for outgoing calls;
// beyond the caps files stay file-level only (graceful degradation, not a failure).
const MAX_SYMBOL_FILES = () => numFromEnv("DEEPAGENT_CODE_INDEX_MAX_SYMBOL_FILES", 400)
const MAX_CALL_SYMBOLS = () => numFromEnv("DEEPAGENT_CODE_INDEX_MAX_CALL_SYMBOLS", 600)
const SYMBOL_CONCURRENCY = () => numFromEnv("DEEPAGENT_CODE_INDEX_SYMBOL_CONCURRENCY", 8)

// Code-ish extensions worth putting on the graph. Kept broad; non-code assets are excluded so the
// index stays a code map, not a file dump.
const CODE_EXTENSIONS = [
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "py", "go", "rs", "java", "kt", "kts", "c", "h", "cc", "cpp", "hpp", "cs",
  "rb", "php", "swift", "scala", "sh", "bash", "zsh", "lua", "sql", "vue", "svelte",
]

// Directory segments never worth indexing (build output, deps, VCS, caches). Filtered post-glob since
// the shared Glob util does not take an ignore list.
const EXCLUDED_SEGMENTS = new Set([
  ".git", "node_modules", "dist", "build", "out", "coverage", ".next", ".turbo",
  ".cache", "vendor", "target", "__pycache__", ".venv", "venv", ".idea", ".vscode",
])

const isExcluded = (rel: string): boolean =>
  rel.split(path.sep).some((seg) => EXCLUDED_SEGMENTS.has(seg))

// Walk the workspace for code files (best-effort). Returns repo-relative paths, capped to MAX_FILES.
const walkCodeFiles = (fsys: FSUtil.Interface, root: string): Effect.Effect<readonly string[]> =>
  Effect.gen(function* () {
    const pattern = `**/*.{${CODE_EXTENSIONS.join(",")}}`
    const matches = yield* fsys.glob(pattern, { cwd: root, absolute: false, include: "file", dot: false })
    const filtered = matches.filter((rel) => !isExcluded(rel))
    return filtered.slice(0, MAX_FILES())
  }).pipe(
    Effect.matchCauseEffect({
      onFailure: () => Effect.succeed([] as readonly string[]),
      onSuccess: (files) => Effect.succeed(files),
    }),
  )

// Read + build a CodeFile for a repo-relative path (bounded). Undefined on any read failure / oversize.
const buildCodeFile = (
  fsys: FSUtil.Interface,
  root: string,
  rel: string,
): Effect.Effect<DeepAgentCodeIndexer.CodeFile | undefined> =>
  Effect.gen(function* () {
    const abs = path.join(root, rel)
    const info = yield* fsys.stat(abs).pipe(Effect.option)
    // Skip files larger than the cap (avoids hashing/holding a huge blob for a first-version index).
    const size = Option.isSome(info) ? Number(info.value.size) : 0
    if (size > MAX_FILE_BYTES()) return undefined
    const content = yield* fsys.readFileStringSafe(abs)
    if (content === undefined) return undefined
    const mtime = Option.isSome(info)
      ? Option.getOrUndefined(Option.map(info.value.mtime, (d) => d.getTime()))
      : undefined
    return {
      // Normalize to forward slashes so the node's logical identity is stable across platforms and
      // matches the path form docs reference for the `references` edge.
      path: rel.split(path.sep).join("/"),
      content,
      ...(typeof mtime === "number" ? { mtimeMs: mtime } : {}),
    } satisfies DeepAgentCodeIndexer.CodeFile
  }).pipe(
    Effect.matchCauseEffect({
      onFailure: () => Effect.succeed(undefined),
      onSuccess: (file) => Effect.succeed(file),
    }),
  )

const EMPTY_RESULT: DeepAgentCodeIndexer.IndexResult = {
  nodeIds: [],
  created: 0,
  updated: 0,
  unchanged: 0,
  edgesCreated: 0,
  outcomes: [],
}

// ---- V3.9 §A symbol extraction (LSP) --------------------------------------------------------------

// LSP SymbolKind (numeric) → the code-indexer's CodeSymbolKind. Only navigable code entities are
// mapped; noise kinds (variable/constant/property/field/...) return undefined and are skipped so the
// symbol graph stays a map of functions/classes/methods/interfaces/types/modules.
const KIND_MAP: Record<number, DeepAgentCodeIndexer.CodeSymbolKind> = {
  2: "module", // Module
  3: "module", // Namespace
  4: "module", // Package
  5: "class", // Class
  6: "method", // Method
  9: "method", // Constructor
  10: "type", // Enum
  11: "interface", // Interface
  12: "function", // Function
  23: "class", // Struct
  26: "type", // TypeParameter
}

type Pos = { line: number; character?: number }
type RangeLike = { start: Pos; end: Pos }
type AnySymbol = {
  name: string
  kind: number
  range?: RangeLike
  selectionRange?: RangeLike
  location?: { range: RangeLike }
  children?: AnySymbol[]
  detail?: string
}

// Flatten a documentSymbol result (hierarchical DocumentSymbol[] with children, OR flat Symbol[]) into
// ExtractedSymbol[] with dotted symbol paths (e.g. "Foo.bar" for method bar on class Foo).
const flattenSymbols = (items: readonly AnySymbol[], prefix: string): DeepAgentCodeIndexer.ExtractedSymbol[] => {
  const out: DeepAgentCodeIndexer.ExtractedSymbol[] = []
  for (const sym of items) {
    if (!sym || typeof sym.name !== "string" || sym.name.length === 0) continue
    const symbolPath = prefix ? `${prefix}.${sym.name}` : sym.name
    const kind = KIND_MAP[sym.kind]
    // DocumentSymbol carries `range`/`selectionRange`; flat Symbol carries `location.range`.
    const rangeSrc = sym.range ?? sym.location?.range ?? sym.selectionRange
    // The identifier position for the callHierarchy probe: prefer `selectionRange` (points AT the name),
    // falling back to the flat-symbol location. Column 0 of the declaration line is usually indentation,
    // so `prepareCallHierarchy` there often resolves nothing — the name position is far more reliable.
    const nameSrc = sym.selectionRange ?? sym.location?.range ?? sym.range
    if (kind) {
      out.push({
        symbolPath,
        kind,
        ...(rangeSrc ? { range: { start: rangeSrc.start.line, end: rangeSrc.end.line } } : {}),
        ...(sym.detail ? { signature: sym.detail } : {}),
        ...(nameSrc
          ? { nameLine: nameSrc.start.line, ...(typeof nameSrc.start.character === "number" ? { nameChar: nameSrc.start.character } : {}) }
          : {}),
      })
    }
    // Recurse into children regardless of whether THIS node was a mapped kind (a namespace may hold
    // functions even if the namespace kind itself is skipped). Use the (possibly unmapped) name as the
    // container prefix so nested symbol paths stay meaningful.
    if (Array.isArray(sym.children) && sym.children.length > 0) {
      out.push(...flattenSymbols(sym.children, symbolPath))
    }
  }
  return out
}

// Resolve a file's relative import specifiers to indexed file paths (posix). Deterministic, no LSP:
// regex-extract module specifiers, resolve only RELATIVE ones (./ ../) against the importing file's
// dir, and keep those that match an indexed path (exact, +ext, or /index+ext). Bare/package imports
// are skipped (they are deps, not first-party graph nodes). This gives the §A.5 file→file `imports`
// edges without a language server, which most servers do not surface via documentSymbol anyway.
const IMPORT_SPECIFIER_RE =
  /(?:import\s[^'"]*from\s*['"]([^'"]+)['"])|(?:import\s*['"]([^'"]+)['"])|(?:require\(\s*['"]([^'"]+)['"]\s*\))|(?:from\s+([.\w/]+)\s+import)/g
const CANDIDATE_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".py"]

const resolveImports = (rel: string, content: string, indexed: ReadonlySet<string>): string[] => {
  const dir = path.posix.dirname(rel)
  const found = new Set<string>()
  for (const m of content.matchAll(IMPORT_SPECIFIER_RE)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4]
    if (!spec || !(spec.startsWith("./") || spec.startsWith("../"))) continue
    const base = path.posix.normalize(path.posix.join(dir, spec))
    for (const ext of CANDIDATE_EXTS) {
      const cand = base + ext
      if (indexed.has(cand)) {
        found.add(cand)
        break
      }
      const idx = path.posix.join(base, `index${ext || ".ts"}`)
      if (indexed.has(idx)) {
        found.add(idx)
        break
      }
    }
  }
  return [...found]
}

// Extract outgoing calls for the given symbols of ONE file via callHierarchy. Best-effort and bounded:
// returns [] when the server does not support callHierarchy (empty prepare) — the language then simply
// gets symbol nodes without calls (§A.3 "无则跳过"). Each call target is mapped to (toPath,
// toSymbolPath=leaf name); the linker later resolves it against extracted symbol nodes (by exact key
// or leaf-name), so an unresolved target is skipped, never an error.
const extractCalls = (
  lsp: LSP.Interface,
  absFile: string,
  relPath: string,
  root: string,
  symbols: readonly DeepAgentCodeIndexer.ExtractedSymbol[],
  budget: { remaining: number },
): Effect.Effect<DeepAgentCodeIndexer.ExtractedCall[]> =>
  Effect.gen(function* () {
    const calls: DeepAgentCodeIndexer.ExtractedCall[] = []
    for (const sym of symbols) {
      if (budget.remaining <= 0) break
      if (!sym.range) continue
      budget.remaining--
      // Probe at the identifier position (selectionRange) when known — column 0 of the declaration line
      // is usually indentation, where prepareCallHierarchy resolves nothing. Fall back to the range start.
      const probeLine = sym.nameLine ?? sym.range.start
      const probeChar = sym.nameChar ?? 0
      const outgoing = yield* lsp
        .outgoingCalls({ file: absFile, line: probeLine, character: probeChar })
        .pipe(Effect.catchCause(() => Effect.succeed([] as any[])))
      for (const call of outgoing as any[]) {
        // outgoingCalls returns CallHierarchyOutgoingCall { to: CallHierarchyItem, fromRanges }.
        const to = call?.to
        const name: unknown = to?.name
        const uri: unknown = to?.uri
        if (typeof name !== "string" || typeof uri !== "string") continue
        const toAbs = uri.startsWith("file://") ? fileUriToPath(uri) : uri
        const toRel = toWorkspaceRel(toAbs, root)
        if (toRel === undefined) continue // outside workspace (e.g. a dependency) → skip
        calls.push({ fromSymbolPath: sym.symbolPath, toPath: toRel, toSymbolPath: name })
      }
    }
    return calls
  }).pipe(Effect.catchCause(() => Effect.succeed([] as DeepAgentCodeIndexer.ExtractedCall[])))

const uriFor = (abs: string): string => pathToFileURL(abs).href

const fileUriToPath = (uri: string): string => {
  try {
    return path.normalize(decodeURIComponent(uri.replace(/^file:\/\//, "")))
  } catch {
    return uri
  }
}

// Absolute path → workspace-relative posix path, or undefined when the path is outside the workspace.
const toWorkspaceRel = (abs: string, root: string): string | undefined => {
  const relOs = path.relative(root, abs)
  if (relOs.startsWith("..") || path.isAbsolute(relOs)) return undefined
  return relOs.split(path.sep).join("/")
}

// A per-file extracted symbol payload plus its resolved calls, held between pass 1 (create nodes) and
// pass 2 (link calls) so cross-file call targets exist before linking.
type FileSymbolPayload = {
  readonly extraction: DeepAgentCodeIndexer.SymbolExtraction
  readonly calls: readonly DeepAgentCodeIndexer.ExtractedCall[]
}

// Run the AST symbol pass for the content-sha-changed files. default-safe: returns without writing on
// any failure; a language without an LSP client / empty documentSymbol contributes nothing (file-level
// degradation). Writes symbol nodes + contains/imports edges (pass 1), then symbol→symbol calls (pass 2).
const runSymbolPass = (input: {
  readonly lsp: LSP.Interface
  readonly root: string
  readonly changed: readonly DeepAgentCodeIndexer.CodeFile[]
  readonly indexedPaths: ReadonlySet<string>
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const targets = input.changed.slice(0, MAX_SYMBOL_FILES())
    if (targets.length === 0) return

    const callBudget = { remaining: MAX_CALL_SYMBOLS() }

    // Extract symbols (+imports+calls) per changed file, bounded concurrency (LSP is the cost center).
    const payloads = yield* Effect.forEach(
      targets,
      (file) =>
        Effect.gen(function* () {
          const abs = path.join(input.root, file.path.split("/").join(path.sep))
          // Imports are pure regex — they need NO language server, so compute them FIRST and always.
          // A language without an LSP client (or with an empty documentSymbol) still gets its file→file
          // `imports` edges; only the symbol/call subtree degrades when LSP is unavailable (§A.5).
          const imports = resolveImports(file.path, file.content, input.indexedPaths)
          const has = yield* input.lsp.hasClients(abs).pipe(Effect.catchCause(() => Effect.succeed(false)))
          const raw = has
            ? yield* input.lsp.documentSymbol(uriFor(abs)).pipe(Effect.catchCause(() => Effect.succeed([] as any[])))
            : []
          const symbols = flattenSymbols(raw as AnySymbol[], "")
          // Nothing to write at all (no symbols AND no resolvable imports) → skip cleanly.
          if (symbols.length === 0 && imports.length === 0) return undefined
          // Calls only make sense when there are symbols to hang them off; skip the LSP call pass otherwise.
          const calls =
            symbols.length > 0
              ? yield* extractCalls(input.lsp, abs, file.path, input.root, symbols, callBudget)
              : []
          const extraction: DeepAgentCodeIndexer.SymbolExtraction = {
            path: file.path,
            contentSha: DeepAgentCodeIndexer.contentShaOf(file.content),
            symbols,
            imports,
          }
          return { extraction, calls } satisfies FileSymbolPayload
        }).pipe(Effect.catchCause(() => Effect.succeed(undefined))),
      { concurrency: SYMBOL_CONCURRENCY() },
    )

    const resolved: FileSymbolPayload[] = []
    for (const p of payloads) if (p !== undefined) resolved.push(p)
    if (resolved.length === 0) return

    // Pass 1 + 2 are pure/synchronous store writes to the SAME cached project store instance.
    yield* Effect.sync(() => {
      const store = AgentGateway.DeepAgentKnowledgeSource.projectStoreFor(input.root)
      // Pass 1: create symbol nodes + contains/imports edges for every changed file. buildCallEdges is
      // deferred so pass 2 can resolve cross-file call targets after ALL symbol nodes exist.
      for (const { extraction } of resolved) {
        DeepAgentCodeIndexer.indexSymbols(store, extraction, { buildCallEdges: false })
      }
      // Pass 2: link symbol→symbol call edges (both endpoints now exist where resolvable).
      for (const { extraction, calls } of resolved) {
        if (calls.length > 0) DeepAgentCodeIndexer.linkCallEdges(store, extraction.path, calls)
      }
    })
  }).pipe(Effect.catchCause(() => Effect.void))

// Run ONE lightweight index pass for a workspace. default-safe end to end: any failure (unconfigured
// knowledge-source, walk/read error, index throw) resolves to a no-op result, never a session crash.
// V3.9 §A: when `lsp` is provided, an AST symbol pass runs AFTER the file-level pass over the
// content-sha-changed files only; without `lsp` the behavior is identical to V3.8.1 (file-level only).
export const indexWorkspace = (input: {
  readonly workspacePath: string
  readonly fsys: FSUtil.Interface
  readonly lsp?: LSP.Interface
}): Effect.Effect<DeepAgentCodeIndexer.IndexResult> =>
  Effect.gen(function* () {
    // knowledge-source must be configured (configureGateway is called on the prompt paths). If not,
    // spin down — writing to an unconfigured store throws, and GraphQuery is empty anyway.
    if (!AgentGateway.DeepAgentKnowledgeSource.isConfigured()) return EMPTY_RESULT

    const files = yield* walkCodeFiles(input.fsys, input.workspacePath)
    if (files.length === 0) return EMPTY_RESULT

    const built = yield* Effect.forEach(files, (rel) => buildCodeFile(input.fsys, input.workspacePath, rel), {
      concurrency: 16,
    })
    const codeFiles = built.filter((f): f is DeepAgentCodeIndexer.CodeFile => f !== undefined)
    if (codeFiles.length === 0) return EMPTY_RESULT

    // File-level pass: write to the SAME cached project store instance GraphQuery unions via
    // storesForWorkspace, so the freshly-written code_symbol nodes are immediately query-hittable
    // (DocumentStore persists to disk AND holds in memory; no invalidateCache needed).
    const result = yield* Effect.sync(() => {
      const store = AgentGateway.DeepAgentKnowledgeSource.projectStoreFor(input.workspacePath)
      return DeepAgentCodeIndexer.indexFiles(store, codeFiles)
    })

    // V3.9 §A symbol pass — only when an LSP interface is supplied. Runs over the files whose
    // content-sha changed this pass (created/updated), not the whole tree. Fully default-safe.
    if (input.lsp) {
      const changedPaths = new Set(
        result.outcomes.filter((o) => o.outcome !== "unchanged").map((o) => o.path),
      )
      const changed = codeFiles.filter((f) => changedPaths.has(f.path))
      if (changed.length > 0) {
        const indexedPaths = new Set(codeFiles.map((f) => f.path))
        yield* runSymbolPass({ lsp: input.lsp, root: input.workspacePath, changed, indexedPaths })
      }
    }

    return result
  }).pipe(
    Effect.matchCauseEffect({
      onFailure: () => Effect.succeed(EMPTY_RESULT),
      onSuccess: (result) => Effect.succeed(result),
    }),
  )

export * as CodeIndexTrigger from "./code-index-trigger"
