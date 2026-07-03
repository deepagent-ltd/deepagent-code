/**
 * IdeFileEditor — IDE 工作区的单文件编辑/预览视图 (V3.6 Phase 1B)
 *
 * 功能：
 *  - 只读时用 FileTabContent（与 Phase 0 一致，shiki 高亮）
 *  - 编辑模式用 CodeEditor（CodeMirror 6）
 *  - Cmd+S 保存：走 sdk.client.file.write CAS（传入 expectedBytes）
 *  - 外部变更检测：消费 file.watcher.updated 推送，显示冲突警告徽章
 *  - 脏状态追踪：标题显示 * 前缀
 */
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { showToast } from "@/utils/toast"
import { useFile } from "@/context/file"
import { useServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"
import { CodeEditor } from "@/components/code-editor"

export interface IdeFileEditorProps {
  /** Normalized file tab identifier (file://...) */
  tab: string
  /** Go back to file tree */
  onClose: () => void
  class?: string
  // ── V3.7 review P1-4: debug integration passthrough ──────────────────────
  /** Breakpoint line numbers (0-based) for this file, from the debug store. */
  breakpoints?: Set<number>
  /** Currently paused line (0-based), when the debugger is stopped in this file. */
  pausedLine?: number
  /** Toggle a breakpoint at a line (0-based). */
  onToggleBreakpoint?: (line: number) => void
  /** Navigate to another file/line (LSP go-to-definition, stack-frame click). */
  onNavigate?: (file: string, line: number) => void
  /** V3.7 #5: scroll+select this line (0-based) when it changes. */
  gotoLine?: number
}

type SaveState = "saved" | "saving" | "error"

export function IdeFileEditor(props: IdeFileEditorProps) {
  const file = useFile()
  const sdk = useServerSDK()
  const language = useLanguage()

  const path = createMemo(() => file.pathFromTab(props.tab))
  const filename = createMemo(() => path()?.split("/").pop() ?? "")

  // ── File content state ────────────────────────────────────────────────────

  const state = createMemo(() => {
    const p = path()
    if (!p) return undefined
    return file.get(p)
  })
  const loadedContent = createMemo(() => state()?.content?.content ?? "")

  // Editor text (may diverge from saved content)
  const [draft, setDraft] = createSignal("")
  const [isDirty, setIsDirty] = createSignal(false)
  const [saveState, setSaveState] = createSignal<SaveState>("saved")

  // Snapshot bytes sent to CAS save
  let snapshotBase64 = ""

  // ── V3.7 Phase 4.1D 编辑锁生命周期 ──────────────────────────────────────────
  let lockId = ""
  let heartbeatId: ReturnType<typeof setInterval> | undefined

  onMount(async () => {
    const p = path()
    if (!p) return
    const res = await file.acquireLock(p)
    if (res.ok && res.lockId) {
      lockId = res.lockId
      // 每15s续租（TTL 30s，心跳间隔15s保证足够余量）
      heartbeatId = setInterval(async () => {
        if (!lockId) return
        const ok = await file.renewLock(lockId)
        if (!ok) lockId = "" // 锁丢失（过期/被覆盖），清除本地状态
      }, 15_000)
    }
    // 无法获取锁时不阻止编辑（已有 CAS 止血），只是无法防止 Agent 并发写
  })

  onCleanup(() => {
    if (heartbeatId !== undefined) clearInterval(heartbeatId)
    if (lockId) {
      void file.releaseLock(lockId)
      lockId = ""
    }
  })

  // When the file loads/reloads from server, reset draft to loaded content
  createEffect(
    on(loadedContent, (next) => {
      setDraft(next)
      setIsDirty(false)
      // Build base64 snapshot for CAS
      snapshotBase64 = btoa(unescape(encodeURIComponent(next)))
    }),
  )

  // ── External change detection (watcher) ──────────────────────────────────

  const [conflictWarning, setConflictWarning] = createSignal(false)

  // When the file is reloaded in the file context after an external change,
  // and we have dirty edits, surface a conflict warning.
  createEffect(
    on(loadedContent, (next, prev) => {
      if (prev === undefined) return        // first load
      if (next === prev) return             // unchanged
      if (!isDirty()) return                // no unsaved changes → silent accept
      setConflictWarning(true)
    }),
  )

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleChange = (value: string) => {
    setDraft(value)
    setIsDirty(value !== loadedContent())
  }

  const handleSave = async (value: string) => {
    const p = path()
    if (!p) return
    setSaveState("saving")
    try {
      const res = await file.writeFile(p, value, snapshotBase64 || undefined)
      if (!res.ok) {
        if (res.error === "stale_content") {
          setConflictWarning(true)
          setSaveState("error")
          showToast({ variant: "error", title: language.t("common.save") + " 失败", description: "文件在保存期间被外部修改，请检查改动后重试。" })
        } else {
          throw new Error(res.error ?? "write failed")
        }
        return
      }
      snapshotBase64 = btoa(unescape(encodeURIComponent(value)))
      setIsDirty(false)
      setSaveState("saved")
      setConflictWarning(false)
      void file.load(p, { force: true })
    } catch (err) {
      setSaveState("error")
      showToast({ variant: "error", title: language.t("common.save") + " 失败", description: String(err) })
    }
  }

  const handleDismissConflict = () => setConflictWarning(false)

  // ── Render ────────────────────────────────────────────────────────────────

  const isLoaded = createMemo(() => !!state()?.loaded)
  const isLoading = createMemo(() => !!state()?.loading)
  const fileError = createMemo(() => state()?.error)

  return (
    <div class={`h-full w-full flex flex-col overflow-hidden ${props.class ?? ""}`}>
      {/* Header bar */}
      <div class="h-10 shrink-0 flex items-center gap-2 px-2 border-b border-border-weaker-base bg-background-stronger">
        <IconButton
          icon="chevron-left"
          variant="ghost"
          class="h-7 w-7 rounded-md shrink-0"
          onClick={props.onClose}
          aria-label={language.t("common.back")}
        />
        <span
          class="min-w-0 flex-1 text-13-medium text-text-strong truncate"
          title={path() ?? ""}
        >
          {isDirty() ? `• ${filename()}` : filename()}
        </span>
        <Show when={saveState() === "saving"}>
          <span class="text-12-regular text-text-weak shrink-0">保存中…</span>
        </Show>
        <Show when={saveState() === "error"}>
          <span class="text-12-regular text-red-400 shrink-0">保存失败</span>
        </Show>
      </div>

      {/* Content area */}
      <div class="flex-1 min-h-0 overflow-hidden">
        <Show when={isLoaded()} fallback={
          <div class="flex items-center justify-center h-full text-text-weak text-13-regular">
            {isLoading()
              ? `${language.t("common.loading")}…`
              : fileError()
                ? fileError()
                : language.t("common.loading")}
          </div>
        }>
          <CodeEditor
            filename={filename()}
            value={draft()}
            onChange={handleChange}
            onSave={handleSave}
            conflictWarning={conflictWarning()}
            onDismissConflict={handleDismissConflict}
            class="h-full"
            enableLsp
            sdkClient={sdk.client as never}
            onNavigate={props.onNavigate}
            breakpoints={props.breakpoints}
            pausedLine={props.pausedLine}
            onToggleBreakpoint={props.onToggleBreakpoint}
            gotoLine={props.gotoLine}
          />
        </Show>
      </div>
    </div>
  )
}
