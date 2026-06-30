import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import path from "path"
import { LSP } from "@/lsp/lsp"
import { LSPResolve } from "@/lsp/resolve"
import DESCRIPTION from "./code_intel.txt"
import { InstanceState } from "@/effect/instance-state"
import { pathToFileURL } from "url"
import { assertExternalDirectoryEffect } from "./external-directory"
import { FSUtil } from "@deepagent-code/core/fs-util"

// L2/L3 (S1-v3.4): the symbol-driven AI IDE entry point. Agents address code by
// symbol name + intent; coordinates are resolved internally (LSPResolve) and hidden.
// L5 will add snippet rendering + evidence artifacts on top of this.

const intents = [
  "definition",
  "references",
  "implementations",
  "type",
  "calls_in",
  "calls_out",
  "supertypes",
  "subtypes",
  "type_hints",
  "hover",
  "rename_preview",
  "quick_fix",
  "outline",
  "diagnostics",
  "overview",
] as const

export type Intent = (typeof intents)[number]

const Position = Schema.Struct({
  file: Schema.String,
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  character: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})

export const Parameters = Schema.Struct({
  symbol: Schema.optional(Schema.String).annotate({
    description: "Symbol name to locate (preferred). e.g. 'resolveTools' or 'AgentGateway'.",
  }),
  file: Schema.optional(Schema.String).annotate({
    description: "Optional: restrict symbol resolution to this file (disambiguation).",
  }),
  position: Schema.optional(Position).annotate({
    description: "Fallback: explicit { file, line, character } (1-based) when you already know the coordinate.",
  }),
  intent: Schema.Literals(intents).annotate({ description: "What to ask about the symbol." }),
  kind: Schema.optional(
    Schema.Literals(["function", "class", "method", "interface", "variable", "constant", "struct", "enum"]),
  ).annotate({ description: "Optional: disambiguate symbols of the same name by kind." }),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "Max items in lists (references/calls). Bounded.",
  }),
  depth: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "Expansion depth for calls_in/calls_out/supertypes/subtypes (default 1, max 3).",
  }),
  scope: Schema.optional(Schema.Literals(["file", "symbol", "workspace"])).annotate({
    description: "For intent:diagnostics — file (default), symbol (file + callers), or workspace (whole repo).",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

// Bounded constants (L3 budget per docs/38).
const MAX_DEPTH = 3
const DEFAULT_LIMIT = 50

type RunCtx = {
  lsp: LSP.Interface
  fs: FSUtil.Interface
  instance: { directory: string; worktree: string }
  args: Params
}

const rel = (instance: { worktree: string }, file: string) => {
  try {
    return path.relative(instance.worktree, file)
  } catch {
    return file
  }
}

const fileURL = (file: string) => pathToFileURL(file).href

// A resolved 0-based coordinate the LSP primitives consume.
type Loc = { file: string; line: number; character: number }

const ok = (title: string, output: string, result: unknown) => ({ title, output, metadata: { result } })

// Resolve params → coordinate. position is 1-based (editor coords) → convert to 0-based.
// Returns either a coordinate, a disambiguation result, a not-found, or no-server signal.
const resolveLoc = Effect.fn("CodeIntel.resolveLoc")(function* (rc: RunCtx) {
  const { args, instance, lsp } = rc
  if (args.position) {
    const file = path.isAbsolute(args.position.file)
      ? args.position.file
      : path.join(instance.directory, args.position.file)
    return {
      kind: "loc" as const,
      loc: { file, line: args.position.line - 1, character: args.position.character - 1 },
    }
  }
  if (!args.symbol) {
    return { kind: "error" as const, message: "Provide either `symbol` or `position`." }
  }
  const file = args.file
    ? path.isAbsolute(args.file)
      ? args.file
      : path.join(instance.directory, args.file)
    : undefined

  // If a file is given but has no LSP server, fall back gracefully.
  if (file) {
    const has = yield* lsp.hasClients(file)
    if (!has) return { kind: "no_server" as const, file }
  }

  const resolved = yield* LSPResolve.resolveSymbol({ lsp, symbol: args.symbol, file, kind: args.kind })
  if (resolved.type === "not_found") {
    return { kind: "not_found" as const, symbol: args.symbol }
  }
  if (resolved.type === "ambiguous") {
    return { kind: "ambiguous" as const, candidates: resolved.candidates }
  }
  const c = resolved.candidate
  return { kind: "loc" as const, loc: { file: c.file, line: c.position.line, character: c.position.character } }
})

// Read one source line (1-based via the 0-based LSP line) for snippet rendering (L5 seed).
const readLine = (fs: FSUtil.Interface, file: string, line0: number) =>
  Effect.gen(function* () {
    const exists = yield* fs.existsSafe(file).pipe(Effect.catch(() => Effect.succeed(false)))
    if (!exists) return undefined
    const content = yield* fs.readFileStringSafe(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (content == null) return undefined
    const lines = content.split("\n")
    return lines[line0]?.trim()
  })

// LSP Location[] → [{ file:line, snippet }]
const renderLocations = (rc: RunCtx, locations: any[], limit: number) =>
  Effect.gen(function* () {
    const out: { ref: string; snippet?: string }[] = []
    for (const loc of locations.slice(0, limit)) {
      const uri: string | undefined = loc?.uri ?? loc?.location?.uri ?? loc?.targetUri
      const range = loc?.range ?? loc?.location?.range ?? loc?.targetSelectionRange ?? loc?.targetRange
      if (!uri || !range) continue
      const file = uri.startsWith("file://") ? decodeURIComponent(uri.replace(/^file:\/\//, "")) : uri
      const line0 = range.start?.line ?? 0
      const snippet = yield* readLine(rc.fs, file, line0)
      out.push({ ref: `${rel(rc.instance, file)}:${line0 + 1}`, snippet })
    }
    return out
  })

const NO_SERVER_HINT =
  "No LSP server is available for this file type. Use grep/read for text search instead — code_intel is for code symbols in languages with a configured language server."

// Render a disambiguation list for an ambiguous symbol.
const renderAmbiguous = (rc: RunCtx, candidates: LSPResolve.Candidate[]) => {
  const lines = candidates.map(
    (c) => `  ${c.name} — ${c.kindLabel} @ ${rel(rc.instance, c.file)}:${c.position.line + 1}`,
  )
  return ok(
    `code_intel: ambiguous symbol '${rc.args.symbol}'`,
    [
      `Symbol '${rc.args.symbol}' matches ${candidates.length} candidates. Re-issue with \`file\` and/or \`kind\` to narrow:`,
      ...lines,
    ].join("\n"),
    { ambiguous: candidates },
  )
}

const runIntent = Effect.fn("CodeIntel.runIntent")(function* (rc: RunCtx) {
  // `outline` and `diagnostics(file)` operate on a file, not a resolved coordinate.
  if (rc.args.intent === "outline") return yield* intentOutline(rc)
  // L4: workspace-scope diagnostics need no symbol/coordinate — answer "what's broken repo-wide".
  if (rc.args.intent === "diagnostics" && rc.args.scope === "workspace") return yield* intentWorkspaceDiagnostics(rc)

  const resolved = yield* resolveLoc(rc)
  if (resolved.kind === "error") return ok("code_intel", resolved.message, { error: resolved.message })
  if (resolved.kind === "no_server") return ok("code_intel: no LSP server", NO_SERVER_HINT, { no_server: true })
  if (resolved.kind === "not_found")
    return ok("code_intel: not found", `No symbol named '${resolved.symbol}' was found.`, { not_found: true })
  if (resolved.kind === "ambiguous") return renderAmbiguous(rc, resolved.candidates)

  const loc = resolved.loc
  // Confirm the resolved file actually has a server (position fallback path).
  const has = yield* rc.lsp.hasClients(loc.file)
  if (!has) return ok("code_intel: no LSP server", NO_SERVER_HINT, { no_server: true })
  yield* rc.lsp.touchFile(loc.file)

  switch (rc.args.intent) {
    case "definition":
      return yield* intentLocations(rc, loc, "definition", (l) => rc.lsp.definition(l))
    case "references":
      return yield* intentLocations(rc, loc, "references", (l) => rc.lsp.references(l))
    case "implementations":
      return yield* intentLocations(rc, loc, "implementations", (l) => rc.lsp.implementation(l))
    case "type":
      return yield* intentLocations(rc, loc, "type", (l) => rc.lsp.typeDefinition(l))
    case "hover":
      return yield* intentHover(rc, loc)
    case "type_hints":
      return yield* intentTypeHints(rc, loc)
    case "rename_preview":
      return yield* intentRenamePreview(rc, loc)
    case "quick_fix":
      return yield* intentQuickFix(rc, loc)
    case "diagnostics":
      return yield* intentDiagnostics(rc, loc)
    case "calls_in":
      return yield* intentRelation(rc, loc, "calls_in")
    case "calls_out":
      return yield* intentRelation(rc, loc, "calls_out")
    case "supertypes":
      return yield* intentRelation(rc, loc, "supertypes")
    case "subtypes":
      return yield* intentRelation(rc, loc, "subtypes")
    case "overview":
      return yield* intentOverview(rc, loc)
    default:
      return ok("code_intel", `Unsupported intent: ${rc.args.intent}`, { error: "unsupported_intent" })
  }
})

const intentLocations = (rc: RunCtx, loc: Loc, label: string, fn: (l: Loc) => Effect.Effect<any[]>) =>
  Effect.gen(function* () {
    const limit = Math.min(rc.args.limit ?? DEFAULT_LIMIT, DEFAULT_LIMIT)
    const raw = yield* fn(loc)
    const rendered = yield* renderLocations(rc, raw, limit)
    if (rendered.length === 0) return ok(`code_intel: ${label}`, `No ${label} found.`, { [label]: [] })
    const body = rendered.map((r) => `  ${r.ref}${r.snippet ? `  | ${r.snippet}` : ""}`).join("\n")
    return ok(`code_intel: ${label} (${rendered.length})`, `${label} (${rendered.length}):\n${body}`, {
      [label]: rendered,
      truncated: raw.length > rendered.length,
    })
  })

const intentHover = (rc: RunCtx, loc: Loc) =>
  Effect.gen(function* () {
    const result = yield* rc.lsp.hover(loc)
    const flat = Array.isArray(result) ? result.find(Boolean) : result
    const text = hoverText(flat)
    return ok("code_intel: hover", text ?? "No hover information.", { hover: flat })
  })

const intentTypeHints = (rc: RunCtx, loc: Loc) =>
  Effect.gen(function* () {
    // Hint over the definition line region.
    const hints = yield* rc.lsp.inlayHint({
      file: loc.file,
      start: { line: loc.line, character: 0 },
      end: { line: loc.line + 1, character: 0 },
    })
    if (!hints.length) return ok("code_intel: type_hints", "No inlay hints.", { type_hints: [] })
    const body = hints
      .map((h: any) => `  ${typeof h.label === "string" ? h.label : JSON.stringify(h.label)}`)
      .join("\n")
    return ok(`code_intel: type_hints (${hints.length})`, `type hints:\n${body}`, { type_hints: hints })
  })

const intentRenamePreview = (rc: RunCtx, loc: Loc) =>
  Effect.gen(function* () {
    // Read-only preview: returns the WorkspaceEdit, never writes. Use a placeholder
    // newName since we only want the edit shape; the agent applies via edit/apply_patch.
    const edit = yield* rc.lsp.rename({ ...loc, newName: "__rename_preview__" })
    if (!edit) return ok("code_intel: rename_preview", "Rename not available here.", { rename_preview: null })
    const fileCount = edit?.changes ? Object.keys(edit.changes).length : (edit?.documentChanges?.length ?? 0)
    return ok(
      "code_intel: rename_preview",
      `Rename would touch ${fileCount} file(s). This is a PREVIEW — apply via edit/apply_patch.`,
      { rename_preview: edit },
    )
  })

const intentQuickFix = (rc: RunCtx, loc: Loc) =>
  Effect.gen(function* () {
    const actions = yield* rc.lsp.codeAction({
      file: loc.file,
      start: { line: loc.line, character: loc.character },
      end: { line: loc.line, character: loc.character },
    })
    if (!actions.length) return ok("code_intel: quick_fix", "No code actions.", { quick_fix: [] })
    const body = actions.map((a: any) => `  ${a.title ?? a.kind ?? "action"}`).join("\n")
    return ok(`code_intel: quick_fix (${actions.length})`, `code actions (preview):\n${body}`, { quick_fix: actions })
  })

const intentDiagnostics = (rc: RunCtx, loc: Loc) =>
  Effect.gen(function* () {
    yield* rc.lsp.touchFile(loc.file, "document")
    const all = yield* rc.lsp.diagnostics()
    let here = all[loc.file] ?? all[path.normalize(loc.file)] ?? []
    // L4 symbol scope: also surface diagnostics in the callers' files (bounded), so
    // "did my signature change break a caller" is answerable without manual hunting.
    const extra: { file: string; diags: any[] }[] = []
    if (rc.args.scope === "symbol") {
      const callers = yield* rc.lsp.incomingCalls(loc).pipe(Effect.catch(() => Effect.succeed([])))
      const callerFiles = new Set<string>()
      for (const c of callers.slice(0, 10)) {
        const uri: string | undefined = c?.from?.uri
        if (!uri) continue
        const f = uri.startsWith("file://") ? decodeURIComponent(uri.replace(/^file:\/\//, "")) : uri
        if (f !== loc.file) callerFiles.add(f)
      }
      for (const f of callerFiles) {
        yield* rc.lsp.touchFile(f, "document").pipe(Effect.catch(() => Effect.void))
        const d = (yield* rc.lsp.diagnostics())[f] ?? []
        if (d.length) extra.push({ file: f, diags: d })
      }
    }
    const fmt = (file: string, diags: any[]) =>
      diags.map(
        (d: any) =>
          `  ${rel(rc.instance, file)}:${(d.range?.start?.line ?? 0) + 1} ${severityLabel(d.severity)} ${d.message}`,
      )
    if (!here.length && !extra.length)
      return ok("code_intel: diagnostics", "No diagnostics for this file.", { diagnostics: [] })
    const lines = [...fmt(loc.file, here), ...extra.flatMap((e) => fmt(e.file, e.diags))]
    return ok(`code_intel: diagnostics (${lines.length})`, `diagnostics:\n${lines.join("\n")}`, {
      diagnostics: here,
      caller_diagnostics: extra,
    })
  })

// L4: project-level diagnostic pull (workspace/diagnostic or fallback aggregation).
const intentWorkspaceDiagnostics = (rc: RunCtx) =>
  Effect.gen(function* () {
    const all = yield* rc.lsp.workspaceDiagnostics()
    const entries = Object.entries(all).filter(([, d]) => d.length > 0)
    if (!entries.length)
      return ok("code_intel: diagnostics (workspace)", "No diagnostics in the workspace.", { diagnostics: {} })
    let count = 0
    const lines: string[] = []
    for (const [file, diags] of entries) {
      for (const d of diags as any[]) {
        count++
        lines.push(
          `  ${rel(rc.instance, file)}:${(d.range?.start?.line ?? 0) + 1} ${severityLabel(d.severity)} ${d.message}`,
        )
      }
    }
    return ok(
      `code_intel: diagnostics (workspace, ${count})`,
      `workspace diagnostics (${count}):\n${lines.join("\n")}`,
      {
        workspace_diagnostics: all,
      },
    )
  })

const intentOutline = (rc: RunCtx) =>
  Effect.gen(function* () {
    const file = rc.args.file ?? rc.args.position?.file
    if (!file) return ok("code_intel: outline", "`outline` requires `file`.", { error: "file_required" })
    const abs = path.isAbsolute(file) ? file : path.join(rc.instance.directory, file)
    const has = yield* rc.lsp.hasClients(abs)
    if (!has) return ok("code_intel: no LSP server", NO_SERVER_HINT, { no_server: true })
    yield* rc.lsp.touchFile(abs)
    const symbols = yield* rc.lsp.documentSymbol(fileURL(abs))
    if (!symbols.length) return ok("code_intel: outline", "No symbols.", { outline: [] })
    const body = symbols
      .map((s: any) => {
        const r = "selectionRange" in s ? s.selectionRange : s.location?.range
        const line = (r?.start?.line ?? 0) + 1
        return `  ${LSPResolve.kindLabel(s.kind)} ${s.name} @ ${rel(rc.instance, abs)}:${line}`
      })
      .join("\n")
    return ok(`code_intel: outline (${symbols.length})`, `outline:\n${body}`, { outline: symbols })
  })

// PLACEHOLDER_RELATION

// L3: bounded relation expansion shared by call hierarchy (calls_in/calls_out) and
// type hierarchy (supertypes/subtypes). Walks level by level with a visited set for
// cycle detection; truncates at MAX_DEPTH and marks `truncated`.
type RelationDir = "calls_in" | "calls_out" | "supertypes" | "subtypes"

const relationStep = (lsp: LSP.Interface, dir: RelationDir, loc: Loc): Effect.Effect<any[]> => {
  switch (dir) {
    case "calls_in":
      return lsp.incomingCalls(loc)
    case "calls_out":
      return lsp.outgoingCalls(loc)
    case "supertypes":
      return lsp.supertypes(loc)
    case "subtypes":
      return lsp.subtypes(loc)
  }
}

// Extract a { name, file, line } node + its onward coordinate from a hierarchy item.
const hierarchyNode = (dir: RelationDir, item: any): { name: string; uri?: string; range?: any } | undefined => {
  // callHierarchy items wrap the target in `.from` (incoming) or `.to` (outgoing).
  // typeHierarchy items are the target directly.
  const target = dir === "calls_in" ? item?.from : dir === "calls_out" ? item?.to : item
  if (!target) return undefined
  return { name: target.name ?? "?", uri: target.uri, range: target.selectionRange ?? target.range }
}

const intentRelation = (rc: RunCtx, loc: Loc, dir: RelationDir) =>
  Effect.gen(function* () {
    const depth = Math.min(Math.max(rc.args.depth ?? 1, 1), MAX_DEPTH)
    const visited = new Set<string>()
    const key = (uri: string | undefined, r: any) =>
      `${uri ?? ""}:${r?.start?.line ?? "?"}:${r?.start?.character ?? "?"}`
    visited.add(key(fileURL(loc.file), { start: { line: loc.line, character: loc.character } }))
    let truncated = false

    type Node = { name: string; ref: string; depth: number }
    const collected: Node[] = []

    const expand = (current: Loc, level: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (level > depth) {
          truncated = true
          return
        }
        const items = yield* relationStep(rc.lsp, dir, current).pipe(Effect.catch(() => Effect.succeed([])))
        for (const item of items) {
          const node = hierarchyNode(dir, item)
          if (!node?.uri || !node.range) continue
          const k = key(node.uri, node.range)
          if (visited.has(k)) continue // cycle detection
          visited.add(k)
          const file = node.uri.startsWith("file://")
            ? decodeURIComponent(node.uri.replace(/^file:\/\//, ""))
            : node.uri
          const line0 = node.range.start?.line ?? 0
          collected.push({ name: node.name, ref: `${rel(rc.instance, file)}:${line0 + 1}`, depth: level })
          if (level < depth) {
            yield* expand({ file, line: line0, character: node.range.start?.character ?? 0 }, level + 1)
          }
        }
      })

    yield* expand(loc, 1)
    if (!collected.length) return ok(`code_intel: ${dir}`, `No ${dir} found.`, { [dir]: [] })
    const body = collected.map((n) => `  ${"  ".repeat(n.depth - 1)}${n.name} @ ${n.ref}`).join("\n")
    return ok(
      `code_intel: ${dir} (${collected.length})`,
      `${dir} (depth ${depth}):\n${body}${truncated ? "\n  … (truncated at max depth)" : ""}`,
      { [dir]: collected, truncated },
    )
  })

// L3: overview — one call aggregates definition + type + references + callers + callees +
// (for class/interface) inheritance + hover doc. Detail to artifact happens in L5.
const intentOverview = (rc: RunCtx, loc: Loc) =>
  Effect.gen(function* () {
    const limit = Math.min(rc.args.limit ?? DEFAULT_LIMIT, DEFAULT_LIMIT)
    const [defs, types, refs, callers, callees, supers, subs, hover, hints] = yield* Effect.all(
      [
        rc.lsp.definition(loc).pipe(Effect.catch(() => Effect.succeed([]))),
        rc.lsp.typeDefinition(loc).pipe(Effect.catch(() => Effect.succeed([]))),
        rc.lsp.references(loc).pipe(Effect.catch(() => Effect.succeed([]))),
        rc.lsp.incomingCalls(loc).pipe(Effect.catch(() => Effect.succeed([]))),
        rc.lsp.outgoingCalls(loc).pipe(Effect.catch(() => Effect.succeed([]))),
        rc.lsp.supertypes(loc).pipe(Effect.catch(() => Effect.succeed([]))),
        rc.lsp.subtypes(loc).pipe(Effect.catch(() => Effect.succeed([]))),
        rc.lsp.hover(loc).pipe(Effect.catch(() => Effect.succeed(null))),
        rc.lsp
          .inlayHint({
            file: loc.file,
            start: { line: loc.line, character: 0 },
            end: { line: loc.line + 1, character: 0 },
          })
          .pipe(Effect.catch(() => Effect.succeed([]))),
      ],
      { concurrency: "unbounded" },
    )

    const definedAt = yield* renderLocations(rc, defs, 1)
    const typeAt = yield* renderLocations(rc, types, 1)
    const references = yield* renderLocations(rc, refs, limit)
    const flatHover = Array.isArray(hover) ? hover.find(Boolean) : hover

    const result = {
      symbol: rc.args.symbol ?? `${rel(rc.instance, loc.file)}:${loc.line + 1}`,
      defined_at: definedAt[0]?.ref,
      type_at: typeAt[0]?.ref,
      type_hints: hints.map((h: any) => (typeof h.label === "string" ? h.label : JSON.stringify(h.label))),
      references,
      callers_count: callers.length,
      callees_count: callees.length,
      supertypes_count: supers.length,
      subtypes_count: subs.length,
      doc: hoverText(flatHover),
    }

    const lines = [
      `overview: ${result.symbol}`,
      result.defined_at ? `  defined: ${result.defined_at}` : undefined,
      result.type_at ? `  type: ${result.type_at}` : undefined,
      result.type_hints.length ? `  type hints: ${result.type_hints.join(", ")}` : undefined,
      `  references: ${references.length}, callers: ${callers.length}, callees: ${callees.length}, supertypes: ${supers.length}, subtypes: ${subs.length}`,
      result.doc ? `  doc: ${result.doc.split("\n")[0]}` : undefined,
      ...(references.length
        ? ["  reference sites:", ...references.map((r) => `    ${r.ref}${r.snippet ? `  | ${r.snippet}` : ""}`)]
        : []),
    ].filter(Boolean) as string[]

    return ok(`code_intel: overview ${result.symbol}`, lines.join("\n"), { overview: result })
  })

const hoverText = (hover: any): string | undefined => {
  if (!hover) return undefined
  const c = hover.contents
  if (typeof c === "string") return c
  if (c?.value) return c.value
  if (Array.isArray(c))
    return c
      .map((x: any) => (typeof x === "string" ? x : x?.value))
      .filter(Boolean)
      .join("\n")
  return undefined
}

const severityLabel = (s: number | undefined) =>
  s === 1 ? "error" : s === 2 ? "warning" : s === 3 ? "info" : s === 4 ? "hint" : "diagnostic"

export const CodeIntelTool = Tool.define(
  "code_intel",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* FSUtil.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (args: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context

          // Resolve the target file (from symbol's `file`, position, or symbol resolution).
          const explicitFile = args.position?.file ?? args.file
          if (explicitFile) {
            const abs = path.isAbsolute(explicitFile) ? explicitFile : path.join(instance.directory, explicitFile)
            yield* assertExternalDirectoryEffect(ctx, abs)
          }

          yield* ctx.ask({
            permission: "lsp",
            patterns: ["*"],
            always: ["*"],
            metadata: { intent: args.intent, symbol: args.symbol, file: explicitFile },
          })

          return yield* runIntent({ lsp, fs, instance, args })
        }).pipe(Effect.orDie),
    }
  }),
)
