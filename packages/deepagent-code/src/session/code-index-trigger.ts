import path from "node:path"
import { Effect, Option } from "effect"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { DeepAgentCodeIndexer } from "@deepagent-code/core/deepagent/index"

// V3.8 Phase 3 (v3.8.1 §B.3) — the code-indexer TRIGGER. code-indexer.ts (registerFile/indexFiles)
// was pure with ZERO production callers, so no `code_symbol` node ever reached the graph and
// GraphQuery/UnifiedContextGraph could never traverse into code. This module is the real trigger: on
// first prompt of a session it runs ONE lightweight, file-level index pass over the workspace and
// writes the nodes into the SAME per-project DurableKnowledgeStore instance that GraphQuery reads
// (via knowledge-source's cached projectStoreFor), so the nodes are immediately query-hittable.
//
// FIRST-VERSION SCOPE (deliberately lightweight, seams marked):
//   - file-level `code_symbol` nodes (path identity + bounded content head) + explicit path-evidence
//     `references` edges only. NO AST/semantic symbol extraction — that is a later version.
//   - SEAM: the fs walk here is a full glob-scan filtered to code extensions with generous caps. An
//     incremental fs-walker (mtime-gated, per docs in code-indexer.ts) is the follow-up; the CodeFile
//     contract already carries mtimeMs for it.
//   - default-safe: everything is wrapped in Effect.matchCauseEffect so a walk/read/index failure
//     spins the capability down (no nodes written) rather than crashing the session boot.

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

// Run ONE lightweight index pass for a workspace. default-safe end to end: any failure (unconfigured
// knowledge-source, walk/read error, index throw) resolves to a no-op result, never a session crash.
export const indexWorkspace = (input: {
  readonly workspacePath: string
  readonly fsys: FSUtil.Interface
}): Effect.Effect<DeepAgentCodeIndexer.IndexResult> =>
  Effect.gen(function* () {
    const empty: DeepAgentCodeIndexer.IndexResult = {
      nodeIds: [],
      created: 0,
      updated: 0,
      unchanged: 0,
      edgesCreated: 0,
    }
    // knowledge-source must be configured (configureGateway is called on the prompt paths). If not,
    // spin down — writing to an unconfigured store throws, and GraphQuery is empty anyway.
    if (!AgentGateway.DeepAgentKnowledgeSource.isConfigured()) return empty

    const files = yield* walkCodeFiles(input.fsys, input.workspacePath)
    if (files.length === 0) return empty

    const built = yield* Effect.forEach(files, (rel) => buildCodeFile(input.fsys, input.workspacePath, rel), {
      concurrency: 16,
    })
    const codeFiles = built.filter((f): f is DeepAgentCodeIndexer.CodeFile => f !== undefined)
    if (codeFiles.length === 0) return empty

    // Write to the SAME cached project store instance GraphQuery unions via storesForWorkspace, so the
    // freshly-written code_symbol nodes are immediately query-hittable (DocumentStore persists to disk
    // AND holds in memory; no invalidateCache needed for same-instance reads).
    return yield* Effect.sync(() => {
      const store = AgentGateway.DeepAgentKnowledgeSource.projectStoreFor(input.workspacePath)
      return DeepAgentCodeIndexer.indexFiles(store, codeFiles)
    })
  }).pipe(
    Effect.matchCauseEffect({
      onFailure: () =>
        Effect.succeed({ nodeIds: [], created: 0, updated: 0, unchanged: 0, edgesCreated: 0 }),
      onSuccess: (result) => Effect.succeed(result),
    }),
  )

export * as CodeIndexTrigger from "./code-index-trigger"
