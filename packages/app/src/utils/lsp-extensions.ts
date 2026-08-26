/**
 * lsp-extensions.ts — CodeMirror 6 LSP 扩展集合 (V3.7 Phase 4.1)
 *
 * 依赖 L1 路由（V3.6 Phase 2 已就绪）:
 *   GET  /lsp/diagnostics
 *   POST /lsp/hover
 *   POST /lsp/definition
 *   POST /lsp/completion
 *   POST /lsp/code-action
 */
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint"
import { hoverTooltip } from "@codemirror/view"
import { autocompletion, type CompletionContext, type CompletionResult, type Completion } from "@codemirror/autocomplete"
import { keymap } from "@codemirror/view"
import type { Extension } from "@codemirror/state"
import { posToLsp, lspToPos, lspKindToCompletionType, lspSeverityToLint } from "@/utils/lsp-coords"

// ── Types for LSP server responses ───────────────────────────────────────────

interface LspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  severity?: number
  message: string
  code?: string | number
}

interface LspHoverResult {
  contents?: string | { kind?: string; value?: string } | Array<{ language?: string; value: string }>
}

interface LspCompletionItem {
  label: string
  kind?: number
  detail?: string
  documentation?: string | { value: string }
  insertText?: string
  filterText?: string
}

interface LspLocation {
  uri?: string
  targetUri?: string
  range?: { start: { line: number; character: number } }
  targetRange?: { start: { line: number; character: number } }
}

// ── SDK client type (minimal interface needed) ────────────────────────────────

interface LspSdkClient {
  lsp: {
    diagnostics(params?: { directory?: string; workspace?: string; path?: string }): Promise<{ data?: unknown }>
    hover(params: { file: string; line: number; character: number }): Promise<{ data?: unknown }>
    definition(params: { file: string; line: number; character: number }): Promise<{ data?: unknown }>
    completion(params: { file: string; line: number; character: number }): Promise<{ data?: unknown }>
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract plain text from LSP hover contents (various formats). */
function hoverText(contents: LspHoverResult["contents"]): string {
  if (!contents) return ""
  if (typeof contents === "string") return contents
  if (Array.isArray(contents)) return contents.map((c) => c.value).join("\n\n")
  return contents.value ?? ""
}

/** Resolve the actual file path from an LSP Location/LocationLink. */
function locationFile(loc: LspLocation): string | undefined {
  const uri = loc.targetUri ?? loc.uri
  if (!uri) return undefined
  // Strip file:// prefix
  return uri.startsWith("file://") ? decodeURIComponent(uri.slice(7)) : uri
}

function locationLine(loc: LspLocation): number {
  return (loc.targetRange?.start.line ?? loc.range?.start.line ?? 0)
}

// ── Diagnostics (lint) ────────────────────────────────────────────────────────

/**
 * Returns a CodeMirror `linter` extension that polls GET /lsp/diagnostics
 * every 800ms of idle time, filtered to the current file.
 */
export function createLspLinter(filename: string, sdkClient: LspSdkClient): Extension {
  return linter(
    async (view) => {
      try {
        // V3.7 #7: pass path so the backend opens/syncs this file with the LSP
        // server before pulling diagnostics (otherwise the server may not have it).
        const res = await sdkClient.lsp.diagnostics({ path: filename })
        const all = res.data as Record<string, LspDiagnostic[]> | undefined
        if (!all) return []

        // Match diagnostics to the current file (server returns absolute paths as keys)
        const fileDiags = Object.entries(all).find(([k]) => k.endsWith(filename))?.[1] ?? []

        return fileDiags.map((d): Diagnostic => ({
          from: lspToPos(view.state, d.range.start),
          to: lspToPos(view.state, d.range.end),
          severity: lspSeverityToLint(d.severity),
          message: d.message,
          ...(d.code ? { renderMessage: () => {
            const el = document.createElement("span")
            el.textContent = `${d.message} [${d.code}]`
            return el
          }} : {}),
        }))
      } catch {
        return []
      }
    },
    { delay: 800 },
  )
}

/** Gutter indicator for diagnostics (red/yellow dots on the line number gutter). */
export const lspLintGutter = lintGutter()

// ── Hover ─────────────────────────────────────────────────────────────────────

/**
 * Returns a CodeMirror `hoverTooltip` extension that calls POST /lsp/hover.
 */
export function createLspHover(filename: string, sdkClient: LspSdkClient): Extension {
  return hoverTooltip(
    async (view, pos) => {
      try {
        const lspPos = posToLsp(view.state, pos)
        const res = await sdkClient.lsp.hover({ file: filename, ...lspPos })
        const data = res.data as LspHoverResult | null
        if (!data) return null
        const text = hoverText(data.contents)
        if (!text.trim()) return null

        return {
          pos,
          end: pos,
          create() {
            const dom = document.createElement("div")
            dom.className = "cm-lsp-tooltip"
            dom.style.cssText =
              "max-width:480px;padding:6px 8px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word"
            dom.textContent = text
            return { dom }
          },
        }
      } catch {
        return null
      }
    },
    { hoverTime: 500, hideOnChange: true },
  )
}

// ── Completion ────────────────────────────────────────────────────────────────

/**
 * Returns a CodeMirror `autocompletion` extension that calls POST /lsp/completion.
 * Triggers on `.`, word characters, and explicit Ctrl+Space.
 */
export function createLspCompletion(filename: string, sdkClient: LspSdkClient): Extension {
  const completionSource = async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const trigger = ctx.matchBefore(/[\w.]+/)
    if (!trigger && !ctx.explicit) return null

    try {
      const lspPos = posToLsp(ctx.state, ctx.pos)
      const res = await sdkClient.lsp.completion({ file: filename, ...lspPos })
      const data = res.data as { items?: LspCompletionItem[] } | LspCompletionItem[] | null
      const items: LspCompletionItem[] = Array.isArray(data) ? data : (data?.items ?? [])
      if (!items.length) return null

      const options: Completion[] = items.map((item) => ({
        label: item.label,
        type: lspKindToCompletionType(item.kind),
        detail: item.detail,
        info: typeof item.documentation === "string"
          ? item.documentation
          : item.documentation?.value,
        apply: item.insertText ?? item.label,
        boost: item.filterText === item.label ? 1 : 0,
      }))

      return {
        from: trigger?.from ?? ctx.pos,
        options,
        validFor: /^\w*$/,
      }
    } catch {
      return null
    }
  }

  return autocompletion({ override: [completionSource] })
}

// ── Go to Definition ──────────────────────────────────────────────────────────

/**
 * Returns a keymap extension that binds F12 to "go to definition"
 * via POST /lsp/definition.
 *
 * @param onNavigate - called with (filePath, line) when a definition is found;
 *   the caller is responsible for opening the target file in the IDE panel.
 */
export function createLspDefinition(
  filename: string,
  sdkClient: LspSdkClient,
  onNavigate?: (file: string, line: number) => void,
): Extension {
  return keymap.of([
    {
      key: "F12",
      run(view) {
        const pos = view.state.selection.main.head
        const lspPos = posToLsp(view.state, pos)
        void sdkClient.lsp
          .definition({ file: filename, ...lspPos })
          .then((res) => {
            const defs = res.data as LspLocation[] | LspLocation | null
            if (!defs) return
            const first = Array.isArray(defs) ? defs[0] : defs
            if (!first) return
            const file = locationFile(first)
            const line = locationLine(first)
            if (file) onNavigate?.(file, line)
          })
          .catch(() => undefined)
        return true
      },
    },
  ])
}

// ── Bundle: all LSP extensions for a file ────────────────────────────────────

export interface LspExtensionsOptions {
  filename: string
  sdkClient: LspSdkClient
  onNavigate?: (file: string, line: number) => void
}

/**
 * Returns all LSP extensions bundled.
 * Import this in code-editor.tsx when `enableLsp` is true.
 */
export function createLspExtensions(opts: LspExtensionsOptions): Extension[] {
  return [
    createLspLinter(opts.filename, opts.sdkClient),
    lspLintGutter,
    createLspHover(opts.filename, opts.sdkClient),
    createLspCompletion(opts.filename, opts.sdkClient),
    createLspDefinition(opts.filename, opts.sdkClient, opts.onNavigate),
  ]
}
