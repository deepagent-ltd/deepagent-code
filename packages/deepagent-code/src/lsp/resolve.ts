import { Effect } from "effect"
import path from "path"
import { pathToFileURL } from "url"
import { LSP } from "./lsp"

/**
 * L2 (S1-v3.4): symbol-name → coordinate resolution, extracted into a shared module
 * (NOT private to code_intel) so it can be reused by:
 *   - the `code_intel` tool (L2/L3),
 *   - L4 diagnostics (symbol-scoped),
 *   - and the V3.5 DAP symbol breakpoints / PAP hotspot back-fill (L7 接口预留).
 *
 * The whole point of the AI IDE microservice is that agents address code by symbol
 * name + intent, never by line/character. Internally we resolve names to coordinates
 * with documentSymbol (file-scoped) or workspaceSymbol (global), and surface a
 * disambiguation list when a name is ambiguous rather than silently picking one.
 */
export namespace LSPResolve {
  /** A resolved coordinate plus the metadata needed to render/disambiguate. */
  export interface Candidate {
    name: string
    /** LSP SymbolKind numeric code. */
    kind: number
    /** Human-readable kind label (function/class/...). */
    kindLabel: string
    file: string
    /** 0-based position to feed LSP primitives. */
    position: { line: number; character: number }
  }

  export type Result =
    | { type: "resolved"; candidate: Candidate }
    | { type: "ambiguous"; candidates: Candidate[] }
    | { type: "not_found" }

  // LSP SymbolKind numeric codes (subset agents care about) ↔ labels.
  const KIND_TO_LABEL: Record<number, string> = {
    5: "class",
    6: "method",
    9: "constructor",
    10: "enum",
    11: "interface",
    12: "function",
    13: "variable",
    14: "constant",
    23: "struct",
    26: "type_parameter",
  }

  const LABEL_TO_KIND: Record<string, number> = {
    function: 12,
    class: 5,
    method: 6,
    interface: 11,
    variable: 13,
    constant: 14,
    struct: 23,
    enum: 10,
  }

  export const kindLabel = (kind: number): string => KIND_TO_LABEL[kind] ?? `kind_${kind}`

  const toCandidate = (name: string, kind: number, file: string, range: LSP.Range): Candidate => ({
    name,
    kind,
    kindLabel: kindLabel(kind),
    file,
    // selectionRange/range start is the symbol's coordinate; LSP positions are 0-based already.
    position: { line: range.start.line, character: range.start.character },
  })

  const fileToUri = (file: string) => pathToFileURL(file).href

  /**
   * Resolve a symbol name to a coordinate.
   * - `file` (optional): restrict resolution to one file (documentSymbol) for disambiguation.
   * - `kind` (optional): filter candidates by symbol kind label.
   *
   * Returns `resolved` for a single match, `ambiguous` with candidates for many,
   * or `not_found` when nothing matches.
   */
  export const resolveSymbol = Effect.fn("LSPResolve.resolveSymbol")(function* (input: {
    lsp: LSP.Interface
    symbol: string
    file?: string
    kind?: string
  }) {
    const wantedKind = input.kind ? LABEL_TO_KIND[input.kind] : undefined
    const candidates: Candidate[] = []

    if (input.file) {
      // File-scoped: documentSymbol returns a tree (DocumentSymbol) or flat (Symbol) list.
      const uri = fileToUri(input.file)
      const symbols = yield* input.lsp.documentSymbol(uri).pipe(Effect.catch(() => Effect.succeed([])))
      const visit = (items: (LSP.DocumentSymbol | LSP.Symbol)[], file: string) => {
        for (const sym of items) {
          // DocumentSymbol has selectionRange; Symbol has location.range.
          const range = "selectionRange" in sym ? sym.selectionRange : (sym as LSP.Symbol).location.range
          if (sym.name === input.symbol && (wantedKind === undefined || sym.kind === wantedKind)) {
            candidates.push(toCandidate(sym.name, sym.kind, file, range))
          }
          // DocumentSymbol children (nested members).
          const children = (sym as unknown as { children?: (LSP.DocumentSymbol | LSP.Symbol)[] }).children
          if (children?.length) visit(children, file)
        }
      }
      visit(symbols, input.file)
    } else {
      // Global: workspaceSymbol. Widen the kind filter so resolution isn't blocked by the
      // default narrow whitelist; we apply the caller's kind filter ourselves.
      const symbols = yield* input.lsp
        .workspaceSymbol(input.symbol, { limit: 50, kinds: Object.values(LABEL_TO_KIND) })
        .pipe(Effect.catch(() => Effect.succeed([] as LSP.Symbol[])))
      for (const sym of symbols) {
        if (sym.name !== input.symbol) continue
        if (wantedKind !== undefined && sym.kind !== wantedKind) continue
        const file = uriToFile(sym.location.uri)
        candidates.push(toCandidate(sym.name, sym.kind, file, sym.location.range))
      }
    }

    if (candidates.length === 0) return { type: "not_found" } as Result
    if (candidates.length === 1) return { type: "resolved", candidate: candidates[0]! } as Result
    // Dedupe identical file:line candidates (some servers list a symbol twice).
    const unique = dedupe(candidates)
    if (unique.length === 1) return { type: "resolved", candidate: unique[0]! } as Result
    return { type: "ambiguous", candidates: unique } as Result
  })

  const uriToFile = (uri: string): string => {
    if (uri.startsWith("file://")) {
      try {
        return path.normalize(decodeURIComponent(uri.replace(/^file:\/\//, "")))
      } catch {
        return uri
      }
    }
    return uri
  }

  const dedupe = (candidates: Candidate[]): Candidate[] => {
    const seen = new Set<string>()
    const out: Candidate[] = []
    for (const c of candidates) {
      const key = `${c.file}:${c.position.line}:${c.position.character}:${c.kind}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(c)
    }
    return out
  }
}
