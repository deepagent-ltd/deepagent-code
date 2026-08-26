/**
 * CodeEditor — CodeMirror 6 编辑器组件 (V3.6 Phase 1B)
 *
 * 纯受控组件：
 *   - value / onChange  管理文本状态
 *   - language          决定语法高亮
 *   - readOnly          只读模式（预览复用）
 *   - onSave            Cmd/Ctrl+S 快捷键保存
 *   - conflictWarning   显示外部变更冲突徽章
 */
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { EditorState, Compartment, RangeSetBuilder } from "@codemirror/state"
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter,
  highlightSpecialChars, drawSelection, dropCursor,
  rectangularSelection, crosshairCursor, highlightActiveLine,
  GutterMarker, gutter } from "@codemirror/view"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search"
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete"
import { foldGutter, indentOnInput, syntaxHighlighting, defaultHighlightStyle,
  bracketMatching, foldKeymap } from "@codemirror/language"
import { javascript } from "@codemirror/lang-javascript"
import { css } from "@codemirror/lang-css"
import { html } from "@codemirror/lang-html"
import { json } from "@codemirror/lang-json"
import { markdown } from "@codemirror/lang-markdown"
import { python } from "@codemirror/lang-python"
import { rust } from "@codemirror/lang-rust"
import { cpp } from "@codemirror/lang-cpp"
import { java } from "@codemirror/lang-java"
import { sql } from "@codemirror/lang-sql"
import { go } from "@codemirror/lang-go"
import { createLspExtensions } from "@/utils/lsp-extensions"

// ── Language detection ────────────────────────────────────────────────────────

function languageExtension(filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase() ?? ""
  switch (ext) {
    case "js": case "mjs": case "cjs": return javascript()
    case "jsx": return javascript({ jsx: true })
    case "ts": return javascript({ typescript: true })
    case "tsx": return javascript({ typescript: true, jsx: true })
    case "css": return css()
    case "html": case "htm": return html()
    case "json": case "jsonc": return json()
    case "md": case "markdown": return markdown()
    case "py": return python()
    case "rs": return rust()
    case "c": case "h": case "cpp": case "cc": case "cxx": return cpp()
    case "java": return java()
    case "sql": return sql()
    case "go": return go()
    default: return []
  }
}

// ── CSS theme aligned with the design system CSS variables ───────────────────

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
    fontFamily: "var(--font-family-mono, 'JetBrains Mono', 'Fira Code', monospace)",
    backgroundColor: "var(--background-stronger, #1e1e1e)",
    color: "var(--text-base, #d4d4d4)",
  },
  ".cm-scroller": { overflow: "auto" },
  ".cm-content": { caretColor: "var(--text-strong, #fff)", padding: "8px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text-strong, #aeafad)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--surface-base-active, #264f78)" },
  ".cm-gutters": {
    backgroundColor: "var(--background-stronger, #1e1e1e)",
    color: "var(--text-weaker, #858585)",
    border: "none",
    borderRight: "1px solid var(--border-weaker-base, #333)",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-base, #c6c6c6)" },
  ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.03)" },
  ".cm-foldPlaceholder": { backgroundColor: "transparent", border: "none", color: "var(--text-weak)" },
  ".cm-tooltip": {
    border: "1px solid var(--border-weak-base)",
    backgroundColor: "var(--background-base)",
    color: "var(--text-base)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--surface-base-active)",
    color: "var(--text-strong)",
  },
})

// ── Props ─────────────────────────────────────────────────────────────────────

export interface CodeEditorProps {
  filename: string
  value: string
  onChange?: (value: string) => void
  readOnly?: boolean
  onSave?: (value: string) => void
  conflictWarning?: boolean
  onDismissConflict?: () => void
  class?: string
  // ── V3.7 Phase 4.1 LSP 集成 ──────────────────────────────────────────────
  /** 启用 LSP 智能（诊断/hover/补全/跳转）。需同时传 sdkClient。默认 false。 */
  enableLsp?: boolean
  /** SDK 客户端，enableLsp=true 时使用。 */
  sdkClient?: { lsp: { diagnostics(...a: any[]): Promise<any>; hover(...a: any[]): Promise<any>; definition(...a: any[]): Promise<any>; completion(...a: any[]): Promise<any> } }
  /** F12 跳转定义回调：(filePath: string, line: number) */
  onNavigate?: (file: string, line: number) => void
  // ── V3.7 Phase 4.3 调试集成（断点/暂停行） ────────────────────────────────
  /** 已设置的断点行号集合（0-based）。 */
  breakpoints?: Set<number>
  /** 当前调试器暂停的行号（0-based）。 */
  pausedLine?: number
  /** 用户点击行号 gutter 时触发（切换断点）。 */
  onToggleBreakpoint?: (line: number) => void
  /** V3.7 #5: 滚动并选中指定行（0-based）。用于跳转定义/栈帧/热点点击定位。 */
  gotoLine?: number
}

// ── Breakpoint gutter (V3.7 Phase 4.3) ──────────────────────────────────────
//
// We render two kinds of gutter markers on the line-number gutter:
//   • red dot  — a breakpoint is set on this line
//   • green arrow — the debugger is currently paused on this line
//
// GutterMarker.toDOM() creates a small inline DOM element that overlays the
// standard `lineNumbers()` gutter. We build them with CSS classes so the
// design-system tokens apply.

class BreakpointMarker extends GutterMarker {
  constructor(readonly paused: boolean) {
    super()
  }
  toDOM() {
    const el = document.createElement("div")
    if (this.paused) {
      // Green arrow — current paused line
      el.className = "cm-debug-paused-line"
      el.textContent = "▶"
      el.style.cssText =
        "color:#4ade80;font-size:10px;line-height:1;cursor:default;display:flex;align-items:center;justify-content:center;width:100%;height:100%"
      el.setAttribute("aria-label", "调试器当前暂停行")
    } else {
      // Red dot — breakpoint
      el.className = "cm-debug-breakpoint"
      el.textContent = "●"
      el.style.cssText =
        "color:#f87171;font-size:10px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;width:100%;height:100%"
      el.setAttribute("aria-label", "断点")
    }
    return el
  }
  eq(other: BreakpointMarker) {
    return other.paused === this.paused
  }
}

const BREAKPOINT_MARKER = new BreakpointMarker(false)
const PAUSED_MARKER = new BreakpointMarker(true)

/**
 * Build the breakpoint gutter extension for a given set of 0-based line numbers
 * and an optional paused line. Clicking the gutter calls `onToggle`.
 */
function buildBreakpointGutter(
  breakpoints: Set<number>,
  pausedLine: number | undefined,
  onToggle: ((line: number) => void) | undefined,
) {
  return gutter({
    class: "cm-breakpoint-gutter",
    markers(view) {
      const builder = new RangeSetBuilder<GutterMarker>()
      const doc = view.state.doc
      for (let lineNo = 1; lineNo <= doc.lines; lineNo++) {
        const lineObj = doc.line(lineNo)
        const zeroLine = lineNo - 1
        if (zeroLine === pausedLine) {
          builder.add(lineObj.from, lineObj.from, PAUSED_MARKER)
        } else if (breakpoints.has(zeroLine)) {
          builder.add(lineObj.from, lineObj.from, BREAKPOINT_MARKER)
        }
      }
      return builder.finish()
    },
    domEventHandlers: {
      mousedown(view, line) {
        if (!onToggle) return false
        const lineObj = view.state.doc.lineAt(line.from)
        onToggle(lineObj.number - 1) // convert to 0-based
        return true
      },
    },
    initialSpacer: () => BREAKPOINT_MARKER,
  })
}

// ── CSS theme additions for breakpoint gutter ─────────────────────────────────

const breakpointGutterTheme = EditorView.theme({
  ".cm-breakpoint-gutter .cm-gutterElement": {
    padding: "0",
    width: "16px",
    minWidth: "16px",
  },
})

// ── Component ─────────────────────────────────────────────────────────────────

export function CodeEditor(props: CodeEditorProps) {
  let container: HTMLDivElement | undefined
  let view: EditorView | undefined
  let ignoreNextUpdate = false

  const readonlyCompartment = new Compartment()
  const languageCompartment = new Compartment()
  const lspCompartment = new Compartment()
  const debugCompartment = new Compartment()

  const extensions = () => [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      indentWithTab,
      {
        key: "Mod-s",
        run: () => {
          if (view && props.onSave) props.onSave(view.state.doc.toString())
          return true
        },
      },
    ]),
    EditorView.updateListener.of((update) => {
      if (ignoreNextUpdate) { ignoreNextUpdate = false; return }
      if (update.docChanged && props.onChange) {
        props.onChange(update.state.doc.toString())
      }
    }),
    editorTheme,
    languageCompartment.of(languageExtension(props.filename)),
    readonlyCompartment.of(EditorState.readOnly.of(props.readOnly ?? false)),
    // V3.7 Phase 4.1: LSP extensions slot (populated when enableLsp=true)
    lspCompartment.of([]),
    // V3.7 Phase 4.3: debug breakpoint gutter slot (populated when breakpoints prop used)
    debugCompartment.of([]),
    breakpointGutterTheme,
  ]

  onMount(() => {
    if (!container) return
    view = new EditorView({
      state: EditorState.create({ doc: props.value, extensions: extensions() }),
      parent: container,
    })
  })

  // Sync external value changes (e.g. reload from watcher)
  createEffect(() => {
    const next = props.value
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== next) {
      ignoreNextUpdate = true
      view.dispatch({
        changes: { from: 0, to: current.length, insert: next },
      })
    }
  })

  // Sync readOnly changes
  createEffect(() => {
    if (!view) return
    view.dispatch({
      effects: readonlyCompartment.reconfigure(EditorState.readOnly.of(props.readOnly ?? false)),
    })
  })

  // Sync language when filename changes
  createEffect(() => {
    if (!view) return
    view.dispatch({
      effects: languageCompartment.reconfigure(languageExtension(props.filename)),
    })
  })

  // V3.7 Phase 4.1: Sync LSP extensions when enableLsp / filename / sdkClient changes
  createEffect(() => {
    if (!view) return
    const enabled = props.enableLsp && props.sdkClient
    const lspExts = enabled
      ? createLspExtensions({
          filename: props.filename,
          sdkClient: props.sdkClient!,
          onNavigate: props.onNavigate,
        })
      : []
    view.dispatch({
      effects: lspCompartment.reconfigure(lspExts),
    })
  })

  // V3.7 Phase 4.3: Sync breakpoint gutter when breakpoints / pausedLine change
  createEffect(() => {
    if (!view) return
    const bps = props.breakpoints ?? new Set<number>()
    const paused = props.pausedLine
    const onToggle = props.onToggleBreakpoint
    view.dispatch({
      effects: debugCompartment.reconfigure(buildBreakpointGutter(bps, paused, onToggle)),
    })
  })

  // V3.7 #5: scroll to + select a target line (0-based) on gotoLine change.
  // Used by go-to-definition, stack-frame clicks, and profile hotspot clicks.
  createEffect(() => {
    const target = props.gotoLine
    if (!view || target === undefined) return
    const lineCount = view.state.doc.lines
    const lineNum = Math.min(Math.max(target + 1, 1), lineCount) // clamp, 1-based
    const line = view.state.doc.line(lineNum)
    view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    })
  })

  onCleanup(() => {
    view?.destroy()
    view = undefined
  })

  return (
    <div class={`flex flex-col h-full overflow-hidden ${props.class ?? ""}`} style={{ position: "relative" }}>
      <Show when={props.conflictWarning}>
        <div class="shrink-0 flex items-center gap-2 px-3 py-1.5 text-12-regular bg-amber-900/30 border-b border-amber-700/40 text-amber-300">
          <span class="i-heroicons-exclamation-triangle size-4 shrink-0" />
          <span class="flex-1 min-w-0">此文件已被外部修改。继续编辑将覆盖外部改动。</span>
          <button
            type="button"
            class="shrink-0 underline cursor-pointer"
            onClick={props.onDismissConflict}
          >
            忽略
          </button>
        </div>
      </Show>
      <div ref={container} class="flex-1 min-h-0 overflow-hidden" />
    </div>
  )
}
