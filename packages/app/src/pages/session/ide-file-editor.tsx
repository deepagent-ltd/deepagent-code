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
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
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
  const saveOwner = createMemo(() => ({ path: path() }))
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
  const [conflictWarning, setConflictWarning] = createSignal(false)

  // Snapshot bytes sent to CAS save
  let snapshotBase64 = ""

  // ── V3.7 Phase 4.1D 编辑锁生命周期 ──────────────────────────────────────────
  type EditLease = NonNullable<Awaited<ReturnType<typeof file.acquireLock>>["lease"]>
  const [lease, setLease] = createSignal<EditLease>()
  const editor = { closed: false }
  onCleanup(() => {
    editor.closed = true
  })
  createEffect(
    on(path, (p) => {
      const owner = {
        closed: false,
        renewing: false,
        lease: undefined as EditLease | undefined,
        heartbeat: undefined as ReturnType<typeof setInterval> | undefined,
      }
      setLease(undefined)
      onCleanup(() => {
        owner.closed = true
        if (owner.heartbeat !== undefined) clearInterval(owner.heartbeat)
        if (owner.lease) void owner.lease.release()
      })
      if (!p) return
      void file.acquireLock(p).then((res) => {
        if (!res.lease) return
        // A late acquisition still belongs to its original client and is released.
        if (owner.closed) {
          void res.lease.release()
          return
        }
        owner.lease = res.lease
        setLease(res.lease)
        owner.heartbeat = setInterval(() => {
          if (owner.closed || owner.renewing || !owner.lease) return
          owner.renewing = true
          void owner.lease
            .renew()
            .then((ok) => {
              if (owner.closed || ok) return
              setLease(undefined)
              if (owner.heartbeat !== undefined) clearInterval(owner.heartbeat)
            })
            .finally(() => {
              owner.renewing = false
            })
        }, 15_000)
      })
    }),
  )

  // When the file loads/reloads from server, reset draft to loaded content
  createEffect(
    on([path, loadedContent], ([p, next], prev) => {
      if (!prev || prev[0] !== p) setSaveState("saved")
      // A watcher refresh cannot overwrite unsaved human edits or their CAS base.
      if (prev && prev[0] === p && isDirty()) {
        if (next !== prev[1]) setConflictWarning(true)
        return
      }
      setDraft(next)
      setIsDirty(false)
      setConflictWarning(false)
      // Build base64 snapshot for CAS
      snapshotBase64 = btoa(unescape(encodeURIComponent(next)))
    }),
  )

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleChange = (value: string) => {
    setDraft(value)
    setIsDirty(value !== loadedContent())
  }

  const handleSave = async (value: string) => {
    const owner = saveOwner()
    const p = owner.path
    if (!p || saveState() === "saving") return
    setSaveState("saving")
    try {
      const res = await file.writeFile(p, value, snapshotBase64, lease()?.lockId)
      if (editor.closed || saveOwner() !== owner) return
      if (!res.ok) {
        if (res.error === "stale_content") {
          setConflictWarning(true)
          setSaveState("error")
          showToast({
            variant: "error",
            title: language.t("common.save") + " 失败",
            description: "文件在保存期间被外部修改，请检查改动后重试。",
          })
        } else {
          throw new Error(res.error ?? "write failed")
        }
        return
      }
      snapshotBase64 = btoa(unescape(encodeURIComponent(value)))
      setIsDirty(draft() !== value)
      setSaveState("saved")
      setConflictWarning(false)
      void file.load(p, { force: true })
    } catch (err) {
      if (editor.closed || saveOwner() !== owner) return
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
        <span class="min-w-0 flex-1 text-13-medium text-text-strong truncate" title={path() ?? ""}>
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
        <Show
          when={isLoaded()}
          fallback={
            <div class="flex items-center justify-center h-full text-text-weak text-13-regular">
              {isLoading()
                ? `${language.t("common.loading")}…`
                : fileError()
                  ? fileError()
                  : language.t("common.loading")}
            </div>
          }
        >
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
