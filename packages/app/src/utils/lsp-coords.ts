/**
 * lsp-coords.ts — CodeMirror ↔ LSP 坐标互转工具 (V3.7 Phase 4.1)
 *
 * LSP 协议使用 0-based { line, character }
 * CodeMirror 使用文档偏移量 pos: number
 */
import type { EditorState } from "@codemirror/state"

export interface LspPosition {
  line: number       // 0-based
  character: number  // 0-based
}

/** CodeMirror pos (文档偏移量) → LSP 0-based { line, character } */
export function posToLsp(state: EditorState, pos: number): LspPosition {
  const line = state.doc.lineAt(pos)
  return {
    line: line.number - 1,      // CodeMirror 行号从 1 开始，LSP 从 0 开始
    character: pos - line.from, // 列偏移量相同
  }
}

/** LSP 0-based { line, character } → CodeMirror pos (文档偏移量) */
export function lspToPos(state: EditorState, lsp: LspPosition): number {
  const lineCount = state.doc.lines
  const lineNum = Math.min(Math.max(lsp.line + 1, 1), lineCount)
  const line = state.doc.line(lineNum)
  const character = Math.min(Math.max(lsp.character, 0), line.length)
  return line.from + character
}

/** LSP CompletionItemKind (1-25) → CodeMirror completion type string */
export function lspKindToCompletionType(kind: number | undefined): string {
  switch (kind) {
    case 2:  return "class"
    case 3:  return "interface"
    case 6:  return "property"
    case 9:  return "enum"
    case 12: return "function"
    case 14: return "keyword"
    case 15: return "snippet"
    case 21: return "type"
    default: return "text"
  }
}

/** LSP DiagnosticSeverity (1-4) → CodeMirror lint severity string */
export function lspSeverityToLint(severity: number | undefined): "error" | "warning" | "info" | "hint" {
  switch (severity) {
    case 1: return "error"
    case 2: return "warning"
    case 3: return "info"
    default: return "hint"
  }
}
