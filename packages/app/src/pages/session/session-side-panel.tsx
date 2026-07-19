import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal, type ComponentProps, type JSX } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { Tabs } from "@deepagent-code/ui/tabs"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { Icon } from "@deepagent-code/ui/icon"
import { Tooltip } from "@deepagent-code/ui/tooltip"
import { ResizeHandle } from "@deepagent-code/ui/resize-handle"
import type { SnapshotFileDiff, VcsFileDiff } from "@deepagent-code/sdk/v2"
import { RIGHT_PANEL_RAIL_PX, type RightPanelWidthBucket, type DockPanelID } from "@/context/layout"

import FileTree from "@/components/file-tree"
import { SidePanelMcp } from "@/pages/session/side-panel-mcp"
import { SidePanelPlugins } from "@/pages/session/side-panel-plugins"
import { useCommand } from "@/context/command"
import { useDebug } from "@/context/debug"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { fetchCapabilities } from "@/components/deepagent/panel-goal.api"
import { createOpenSessionFileTab, createSessionTabs, type Sizing } from "@/pages/session/helpers"
import { IdeFileEditor } from "@/pages/session/ide-file-editor"
import { setSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import { SidePanelSubagents } from "@/pages/session/side-panel-subagents"
import { SidePanelBrowser } from "@/pages/session/side-panel-browser"
import { SidePanelWorktree } from "@/pages/session/side-panel-worktree"
import { SidePanelDebug } from "@/pages/session/side-panel-debug"
import { SidePanelProfile } from "@/pages/session/side-panel-profile"
import { SidePanelIM } from "@/pages/session/side-panel-im"
import { SidePanelOversight } from "@/pages/session/side-panel-oversight"
import { SidePanelDockHeader, SidePanelTerminal, SidePanelDebugConsole } from "@/pages/session/side-panel-terminal"
import { ProblemsPanel } from "@/pages/session/problems-panel"

type RenderDiff = (SnapshotFileDiff & { file: string }) | VcsFileDiff

// T3.1 — the single source of truth for the right-panel entries. Every panel is one row here; the memo
// boolean, the click handler, the rail button, and the content <Switch> arm are all DERIVED from this
// list, so adding a panel means adding ONE entry (not editing 5 parallel places as before). T3.3 adds
// `group` (rail sectioning) and `bucket` (which remembered width this panel uses).
type PanelMode =
  | "review"
  | "files"
  | "subagents"
  | "im"
  | "oversight"
  | "browser"
  | "worktree"
  | "mcp"
  | "plugins"
  | "debug"
  | "profile"
  | "terminal"
  | "debug-console"
  | "problems"

type PanelGroup = "code" | "agents" | "env" | "dev" | "dock"

// Movable panel views appear in this rail only when their persisted location is
// side. Other entries remain side-native.
const DOCK_PANEL_MODES: readonly DockPanelID[] = ["terminal", "debug-console", "problems"]

type PanelDef = {
  readonly mode: PanelMode
  readonly icon: ComponentProps<typeof Icon>["name"]
  readonly titleKey: string
  readonly group: PanelGroup
  // Wide panels (diff/files) get the wide remembered width; everything else the narrow one (T3.3).
  readonly bucket: RightPanelWidthBucket
  // Keybind command id (rendered on the rail tooltip), if any.
  readonly keybind?: string
  // Gate the entry on a server capability (T1.1). Absent ⇒ always shown.
  readonly capability?: "oversight"
}

// Order = rail order. Groups are contiguous so the rail can draw a divider between them.
const PANELS: readonly PanelDef[] = [
  // Code
  { mode: "review", icon: "review", titleKey: "session.tab.review", group: "code", bucket: "wide", keybind: "review.toggle" },
  { mode: "files", icon: "file-tree", titleKey: "settings.general.row.showFileTree.title", group: "code", bucket: "wide", keybind: "fileTree.toggle" },
  // Agents
  { mode: "subagents", icon: "agent-tree", titleKey: "session.subagents.title", group: "agents", bucket: "narrow" },
  { mode: "im", icon: "bubble-5", titleKey: "session.tab.im", group: "agents", bucket: "narrow" },
  { mode: "oversight", icon: "oversight", titleKey: "session.panel.oversight", group: "agents", bucket: "narrow", capability: "oversight" },
  // Env
  { mode: "browser", icon: "window-cursor", titleKey: "browser.title", group: "env", bucket: "narrow" },
  { mode: "worktree", icon: "branch", titleKey: "worktree.title", group: "env", bucket: "narrow" },
  // Dev
  { mode: "mcp", icon: "mcp", titleKey: "status.popover.tab.mcp", group: "dev", bucket: "narrow" },
  { mode: "plugins", icon: "plugin", titleKey: "status.popover.tab.plugins", group: "dev", bucket: "narrow" },
  { mode: "debug", icon: "debug", titleKey: "session.panel.debug", group: "dev", bucket: "narrow" },
  { mode: "profile", icon: "profile", titleKey: "session.panel.profile", group: "dev", bucket: "narrow" },
  // Dock — the movable panels; only surface here when docked to the side (see gating below).
  { mode: "terminal", icon: "terminal-active", titleKey: "session.panel.terminal", group: "dock", bucket: "narrow", keybind: "terminal.toggle" },
  { mode: "debug-console", icon: "code-lines", titleKey: "session.panel.debugConsole", group: "dock", bucket: "narrow" },
  { mode: "problems", icon: "warning", titleKey: "session.panel.problems", group: "dock", bucket: "narrow" },
]

const GROUP_ORDER: readonly PanelGroup[] = ["code", "agents", "env", "dev", "dock"]

function renderDiff(value: SnapshotFileDiff | VcsFileDiff): value is RenderDiff {
  return typeof value.file === "string"
}

export function SessionSidePanel(props: {
  canReview: () => boolean
  diffs: () => (SnapshotFileDiff | VcsFileDiff)[]
  diffsReady: () => boolean
  empty: () => string
  hasReview: () => boolean
  reviewCount: () => number
  reviewPanel: () => JSX.Element
  activeDiff?: string
  focusReviewDiff: (path: string) => void
  reviewSnap: boolean
  size: Sizing
  onFileNavigate?: (navigate: (filePath: string, line: number) => void) => void
}) {
  const layout = useLayout()
  const file = useFile()
  const debug = useDebug()
  const language = useLanguage()
  const command = useCommand()
  const sync = useSync()
  const sdk = useSDK()
  const { params, sessionKey, tabs, view } = useSessionLayout()

  const isDesktop = createMediaQuery("(min-width: 768px)")

  // T1.1 — gate flag-off panel entries on the server's advertised capabilities so an entry never opens
  // a permanently-empty dead-end. The Oversight Approval Queue's producers live behind
  // v4MultiAgentRuntime (default OFF); when it is off the queue can never be fed, so we hide the icon
  // rather than let a user open an empty panel with no way to populate it. Tolerant of an older server
  // (fetch fails ⇒ all V4 flags treated OFF ⇒ entry hidden).
  const [capabilities] = createResource(() =>
    fetchCapabilities(sdk.client as unknown as Parameters<typeof fetchCapabilities>[0]).catch(() => null),
  )
  const oversightEnabled = () => capabilities()?.v4MultiAgentRuntime ?? false

  // T3.3 rail badge: the count of PENDING Approval-Queue items, so a supervisor sees a number on the
  // Oversight icon without opening the panel. Only fetched when the capability is on (else the route
  // fails-closed); best-effort — a failure just yields 0 (no badge).
  const [oversightApprovals] = createResource(oversightEnabled, async (enabled) => {
    if (!enabled) return 0
    try {
      const { fetchOversightApprovals } = await import("@/components/deepagent/oversight.api")
      const items = await fetchOversightApprovals(sdk.client as unknown as Parameters<typeof fetchOversightApprovals>[0])
      return items.length
    } catch {
      return 0
    }
  })
  const oversightPendingCount = () => oversightApprovals() ?? 0

  // Subagents = child sessions (parentID === current). Surface a live count on the sidebar icon so
  // the user sees a spawn happened without opening the panel; the running count (session_working)
  // drives a pulsing badge, matching the running dot inside the panel list.
  const subagentChildren = createMemo(() => {
    const id = params.id
    if (!id) return []
    return sync.data.session.filter((s) => s.parentID === id)
  })
  const runningSubagentCount = createMemo(
    () => subagentChildren().filter((s) => sync.data.session_working(s.id)).length,
  )

  // T3.1: the active panel mode (desktop only), derived once from the layout store instead of one memo
  // per panel. `isActive(mode)` and `open()` fall out of it.
  const activeMode = createMemo<PanelMode | undefined>(() => {
    if (!isDesktop()) return undefined
    const mode = view().rightPanel.mode()
    return mode && PANELS.some((p) => p.mode === mode) ? (mode as PanelMode) : undefined
  })
  const isActive = (mode: PanelMode) => activeMode() === mode
  const open = createMemo(() => activeMode() !== undefined)
  // Per-panel remembered width (T3.3): the wide bucket for diff/files, the narrow bucket for the rest.
  const activeBucket = createMemo<RightPanelWidthBucket>(
    () => PANELS.find((p) => p.mode === activeMode())?.bucket ?? "wide",
  )
  const contentWidth = createMemo(() => layout.rightPanel.width(activeBucket()))
  const panelWidth = createMemo(() => (open() ? `${contentWidth()}px` : "0px"))

  const diffs = createMemo(() => props.diffs().filter(renderDiff))
  const diffFiles = createMemo(() => diffs().map((d) => d.file))
  const kinds = createMemo(() => {
    const merge = (a: "add" | "del" | "mix" | undefined, b: "add" | "del" | "mix") => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }

    const normalize = (p: string) => p.replaceAll("\\\\", "/").replace(/\/+$/, "")

    const out = new Map<string, "add" | "del" | "mix">()
    for (const diff of diffs()) {
      const file = normalize(diff.file)
      const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

      out.set(file, kind)

      const parts = file.split("/")
      for (const [idx] of parts.slice(0, -1).entries()) {
        const dir = parts.slice(0, idx + 1).join("/")
        if (!dir) continue
        out.set(dir, merge(out.get(dir), kind))
      }
    }
    return out
  })

  const empty = (msg: string) => (
    <div class="h-full flex flex-col">
      <div class="h-6 shrink-0" aria-hidden />
      <div class="flex-1 pb-64 flex items-center justify-center text-center">
        <div class="text-12-regular text-text-weak">{msg}</div>
      </div>
    </div>
  )

  const nofiles = createMemo(() => {
    const state = file.tree.state("")
    if (!state?.loaded) return false
    return file.tree.children("").length === 0
  })

  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  // V3.6 P0-1: clicking a file in the "all files" tree used to force the review panel open, which
  // only renders diffs — so a non-changed file appeared to do nothing. Now we stay in the files
  // panel and render the file preview inline (see filePreviewTab / FileTabContent below).
  const openTab = createOpenSessionFileTab({
    normalizeTab,
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    setActive: tabs().setActive,
  })

  // The file tab (if any) the files panel should preview. Mirrors createSessionTabs.activeFileTab
  // but scoped to this panel so opening a file swaps the tree for its content.
  const fileTabs = createSessionTabs({ tabs, pathFromTab: file.pathFromTab, normalizeTab })
  const previewTab = fileTabs.activeFileTab
  const previewPath = createMemo(() => {
    const tab = previewTab()
    return tab ? file.pathFromTab(tab) : undefined
  })
  const closePreview = () => {
    const tab = previewTab()
    if (tab) tabs().close(tab)
  }

  // V3.7 #5: target line to scroll to after opening a file (go-to-definition,
  // stack-frame click, profile hotspot click). 0-based; bumped each navigation so
  // repeated jumps to the same line still re-trigger the editor's scroll effect.
  const [gotoLine, setGotoLine] = createSignal<number | undefined>(undefined)

  // V3.7 Phase 4.5: open a file in the preview editor. `line` is 0-based.
  const openFileAt = (filePath: string, line: number) => {
    const clean = filePath.startsWith("file://") ? decodeURIComponent(filePath.slice(7)) : filePath
    openTab(file.tab(file.normalize(clean)))
    // Set after the tab opens so the editor mounts on the new file first.
    setGotoLine(undefined)
    queueMicrotask(() => setGotoLine(line))
  }
  createEffect(() => props.onFileNavigate?.(openFileAt))

  // V3.6 Phase 1B F5 — inline new-file/folder creation state
  const [newItemState, setNewItemState] = createSignal<{ type: "file" | "dir"; name: string } | null>(null)
  const startNewItem = (type: "file" | "dir") => setNewItemState({ type, name: "" })
  const cancelNewItem = () => setNewItemState(null)

  const commitNewItem = async () => {
    const s = newItemState()
    if (!s || !s.name.trim()) { cancelNewItem(); return }
    const name = s.name.trim()
    cancelNewItem()
    if (s.type === "file") {
      const res = await file.createFile(name)
      if (!res.ok) {
        const { showToast } = await import("@/utils/toast")
        showToast({ variant: "error", title: language.t("session.files.create.failed"), description: res.error ?? "unknown" })
      } else {
        void file.load(name)
      }
    } else {
      const res = await file.mkdir(name)
      if (!res.ok) {
        const { showToast } = await import("@/utils/toast")
        showToast({ variant: "error", title: language.t("session.files.createFolder.failed"), description: res.error ?? "unknown" })
      }
    }
  }

  const fileTreeTab = () => layout.fileTree.tab()

  const setFileTreeTabValue = (value: string) => {
    if (value !== "changes" && value !== "all") return
    layout.fileTree.setTab(value)
  }

  // T3.2: switch to a panel with ONE click (was 2 — return-to-menu then pick). Clicking the active
  // panel's rail icon closes the panel (toggle), matching the titlebar toggle.
  const openPanel = (mode: PanelMode) => {
    view().reviewPanel.close()
    layout.fileTree.close()
    if (DOCK_PANEL_MODES.includes(mode as DockPanelID)) {
      view().panel.toggle(mode as DockPanelID)
      return
    }
    if (isActive(mode)) {
      view().rightPanel.close()
      return
    }
    view().rightPanel.open(mode)
  }
  // T3.2: a content panel's close button now CLOSES the panel (was: return to the menu list). The rail
  // stays visible, so the user re-opens with one click.
  const closePanel = () => view().rightPanel.close()

  // T3.1/T3.3: the rail entries, derived from PANELS — capability-gated (T1.1), with a live badge count
  // per panel. review-change-count / running-subagent-count / oversight-pending feed `item.badge`; the
  // rail renders whatever number is present.
  const badgeFor = (mode: PanelMode): number | undefined => {
    if (mode === "review") return props.hasReview() ? props.reviewCount() : undefined
    if (mode === "subagents") return runningSubagentCount() > 0 ? runningSubagentCount() : undefined
    if (mode === "oversight") return oversightPendingCount() > 0 ? oversightPendingCount() : undefined
    return undefined
  }
  const railItems = createMemo(() =>
    PANELS.filter((p) => (p.capability === "oversight" ? oversightEnabled() : true))
      // Dock panels (terminal / debug-console) only appear in the rail when docked to the side; when
      // in the bottom dock they're reached there instead.
      .filter((p) => (DOCK_PANEL_MODES.includes(p.mode as DockPanelID) ? view().panel.location(p.mode as DockPanelID) === "side" : true))
      .map((p) => ({
        ...p,
        title: language.t(p.titleKey),
        keybindLabel: p.keybind ? command.keybind(p.keybind) : undefined,
        active: isActive(p.mode),
        badge: badgeFor(p.mode),
      })),
  )

  createEffect(() => {
    if (!file.ready()) return

    setSessionHandoff(sessionKey(), {
      files: tabs()
        .all()
        .reduce<Record<string, SelectedLineRange | null>>((acc, tab) => {
          const path = file.pathFromTab(tab)
          if (!path) return acc

          const selected = file.selectedLines(path)
          acc[path] =
            selected && typeof selected === "object" && "start" in selected && "end" in selected
              ? (selected as SelectedLineRange)
              : null

          return acc
        }, {}),
    })
  })

  return (
    // T3.4 — the entire right panel (rail + content) is DESKTOP-ONLY (≥768px). This is a deliberate
    // simplification, not an oversight: on a narrow window the session/composer takes the full width and
    // the panel's functions are reached other ways (titlebar toggles, commands). No mobile drawer is
    // provided. Revisit only if the product targets tablet/phone widths as a first-class surface.
    <Show when={isDesktop()}>
      {/* T3.2 — aside = a fixed, always-on icon RAIL + an animated CONTENT region. The rail is always
          interactive (it's the switcher); only the content region collapses to 0 width when closed. */}
      <aside
        id="review-panel"
        aria-label={language.t("session.panel.reviewAndFiles")}
        class="relative min-w-0 h-full flex shrink-0 overflow-hidden bg-background-base border-l border-border-weaker-base"
      >
        <SidePanelRail
          items={railItems}
          groupOrder={GROUP_ORDER}
          onSelect={openPanel}
          collapseLabel={language.t("common.close")}
        />
        <div
          class="relative min-w-0 h-full overflow-hidden bg-background-base border-l border-border-weaker-base"
          aria-hidden={!open()}
          inert={!open()}
          classList={{
            "pointer-events-none": !open(),
            "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
              !props.size.active() && !props.reviewSnap,
          }}
          style={{ width: panelWidth() }}
        >
          <Show when={open()}>
            <div class="size-full flex">
              <div onPointerDown={() => props.size.start()}>
                <ResizeHandle
                  direction="horizontal"
                  edge="start"
                  size={contentWidth()}
                  min={layout.rightPanel.minWidth}
                  max={layout.rightPanel.maxWidth()}
                  onResize={(width) => {
                    props.size.touch()
                    layout.rightPanel.resize(width, activeBucket())
                  }}
                />
              </div>
            <Switch>
              <Match when={isActive("review")}>
                <div class="h-full w-full min-w-0 overflow-hidden bg-background-base">{props.reviewPanel()}</div>
              </Match>
              <Match when={isActive("files")}>
                <Show
                  when={previewPath()}
                  fallback={
                    <div id="file-tree-panel" class="h-full w-full min-w-0 overflow-hidden bg-background-base">
                      <Tabs
                        variant="pill"
                        value={fileTreeTab()}
                        onChange={setFileTreeTabValue}
                        class="h-full"
                        data-scope="filetree"
                      >
                        <Tabs.List>
                          <Tabs.Trigger value="changes" class="flex-1" classes={{ button: "w-full" }}>
                            {props.reviewCount()}{" "}
                            {language.t(
                              props.reviewCount() === 1 ? "session.review.change.one" : "session.review.change.other",
                            )}
                          </Tabs.Trigger>
                          <Tabs.Trigger value="all" class="flex-1" classes={{ button: "w-full" }}>
                            {language.t("session.files.all")}
                          </Tabs.Trigger>
                        </Tabs.List>
                        <Tabs.Content value="changes" class="bg-background-stronger px-3 py-0">
                          <Switch>
                            <Match when={props.hasReview() || !props.diffsReady()}>
                              <Show
                                when={props.diffsReady()}
                                fallback={
                                  <div class="px-2 py-2 text-12-regular text-text-weak">
                                    {language.t("common.loading")}
                                    {language.t("common.loading.ellipsis")}
                                  </div>
                                }
                              >
                                <FileTree
                                  path=""
                                  class="pt-3"
                                  allowed={diffFiles()}
                                  kinds={kinds()}
                                  draggable={false}
                                  active={props.activeDiff}
                                  onFileClick={(node) => props.focusReviewDiff(node.path)}
                                />
                              </Show>
                            </Match>
                          </Switch>
                        </Tabs.Content>
                        <Tabs.Content value="all" class="bg-background-stronger px-3 py-0">
                          {/* V3.6 Phase 1B F5: file ops toolbar */}
                          <div class="flex items-center gap-1 py-1.5 -mx-3 px-3 border-b border-border-weaker-base">
                            <span class="flex-1 text-12-regular text-text-weak">{language.t("session.files.heading")}</span>
                            <IconButton
                              icon="plus"
                              variant="ghost"
                              size="small"
                              class="h-6 w-6 rounded-md"
                              onClick={() => startNewItem("file")}
                              aria-label={language.t("session.files.newFile")}
                            />
                            <IconButton
                              icon="folder"
                              variant="ghost"
                              size="small"
                              class="h-6 w-6 rounded-md"
                              onClick={() => startNewItem("dir")}
                              aria-label={language.t("session.files.newFolder")}
                            />
                          </div>
                          <Show when={newItemState()}>
                            {(s) => (
                              <div class="flex items-center gap-1 py-1">
                                <input
                                  class="flex-1 min-w-0 bg-surface-base-active rounded px-2 py-0.5 text-12-regular text-text-strong outline-none border border-border-weak-base"
                                  placeholder={
                                    s().type === "file"
                                      ? language.t("session.files.newFile.placeholder")
                                      : language.t("session.files.newFolder.placeholder")
                                  }
                                  value={s().name}
                                  onInput={(e) => setNewItemState({ ...s(), name: e.currentTarget.value })}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") void commitNewItem()
                                    if (e.key === "Escape") cancelNewItem()
                                  }}
                                  ref={(el) => setTimeout(() => el?.focus(), 0)}
                                />
                                <IconButton
                                  icon="check"
                                  variant="ghost"
                                  size="small"
                                  class="h-6 w-6 rounded-md shrink-0"
                                  onClick={commitNewItem}
                                  aria-label={language.t("session.files.create.confirm")}
                                />
                                <IconButton
                                  icon="close-small"
                                  variant="ghost"
                                  size="small"
                                  class="h-6 w-6 rounded-md shrink-0"
                                  onClick={cancelNewItem}
                                  aria-label={language.t("session.files.create.cancel")}
                                />
                              </div>
                            )}
                          </Show>
                          <Switch>
                            <Match when={nofiles()}>{empty(language.t("session.files.empty"))}</Match>
                            <Match when={true}>
                              <FileTree
                                path=""
                                class="pt-1"
                                modified={diffFiles()}
                                kinds={kinds()}
                                onFileClick={(node) => openTab(file.tab(node.path))}
                              />
                            </Match>
                          </Switch>
                        </Tabs.Content>
                      </Tabs>
                    </div>
                  }
                >
                  {(_p) => (
                    <IdeFileEditor
                      tab={previewTab()!}
                      onClose={closePreview}
                      class="h-full w-full min-w-0"
                      breakpoints={debug.breakpointsFor(previewPath() ?? "")}
                      pausedLine={(() => {
                        const paused = debug.state.pausedLocation
                        return paused && paused.file === previewPath() ? paused.line : undefined
                      })()}
                      onToggleBreakpoint={(line) => {
                        const p = previewPath()
                        if (p) void debug.toggleBreakpoint(p, line)
                      }}
                      onNavigate={openFileAt}
                      gotoLine={gotoLine()}
                    />
                  )}
                </Show>
              </Match>
              <Match when={isActive("subagents")}>
                <SidePanelSubagents onClose={closePanel} />
              </Match>
              <Match when={isActive("browser")}>
                <SidePanelBrowser onClose={closePanel} />
              </Match>
              <Match when={isActive("worktree")}>
                <SidePanelWorktree onClose={closePanel} />
              </Match>
              <Match when={isActive("mcp")}>
                <SidePanelMcp onClose={closePanel} />
              </Match>
              <Match when={isActive("plugins")}>
                <SidePanelPlugins onClose={closePanel} />
              </Match>
              <Match when={isActive("debug")}>
                <SidePanelDebug onClose={closePanel} onNavigate={openFileAt} />
              </Match>
              <Match when={isActive("profile")}>
                <SidePanelProfile onClose={closePanel} />
              </Match>
              <Match when={isActive("im")}>
                <SidePanelIM onClose={closePanel} />
              </Match>
              <Match when={isActive("oversight")}>
                <SidePanelOversight onClose={closePanel} />
              </Match>
              <Match when={isActive("terminal")}>
                <SidePanelTerminal onClose={() => view().panel.toggle("terminal")} />
              </Match>
              <Match when={isActive("debug-console")}>
                <SidePanelDebugConsole onClose={() => view().panel.toggle("debug-console")} />
              </Match>
              <Match when={isActive("problems")}>
                <div class="h-full w-full min-w-0 flex flex-col overflow-hidden bg-background-stronger">
                  <SidePanelDockHeader id="problems" title={language.t("session.panel.problems")} onClose={() => view().panel.toggle("problems")} />
                  <div class="flex-1 min-h-0">
                    <ProblemsPanel active={() => isActive("problems")} onOpenFile={openFileAt} />
                  </div>
                </div>
              </Match>
            </Switch>
            </div>
          </Show>
        </div>
      </aside>
    </Show>
  )
}

type RailItem = {
  readonly mode: PanelMode
  readonly icon: ComponentProps<typeof Icon>["name"]
  readonly title: string
  readonly group: PanelGroup
  readonly active: boolean
  readonly badge?: number
  readonly keybindLabel?: string
}

// T3.2/T3.3 — the always-on vertical icon rail. ~44px fixed strip; one icon per panel, grouped with a
// divider between groups (T3.3). A click switches the content panel in ONE step (or closes it if that
// panel is already active). Each icon carries a tooltip (title + keybind) and an optional badge count.
function SidePanelRail(props: {
  items: () => RailItem[]
  groupOrder: readonly PanelGroup[]
  onSelect: (mode: PanelMode) => void
  collapseLabel: string
}) {
  return (
    <div
      class="h-full shrink-0 flex flex-col items-center gap-0.5 py-2 overflow-y-auto bg-background-base"
      style={{ width: `${RIGHT_PANEL_RAIL_PX}px` }}
      role="tablist"
      aria-label={props.collapseLabel}
    >
      <For each={props.groupOrder}>
        {(group, gi) => {
          const groupItems = () => props.items().filter((it) => it.group === group)
          return (
            <Show when={groupItems().length > 0}>
              {/* divider between non-empty groups (not before the first) */}
              <Show when={gi() > 0}>
                <div class="my-1 h-px w-6 bg-border-weaker-base shrink-0" aria-hidden />
              </Show>
              <For each={groupItems()}>
                {(item) => (
                  <Tooltip
                    placement="left"
                    gutter={6}
                    value={item.keybindLabel ? `${item.title} · ${item.keybindLabel}` : item.title}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={item.active}
                      aria-label={item.title}
                      class="relative h-8 w-8 rounded-md flex items-center justify-center transition-colors text-icon-base hover:bg-surface-raised-base-hover"
                      classList={{
                        "bg-surface-raised-base-active text-text-strong ring-1 ring-border-strong-base": item.active,
                      }}
                      onClick={() => props.onSelect(item.mode)}
                    >
                      <Icon name={item.icon} size="small" class="shrink-0" />
                      <Show when={item.badge}>
                        {(badge) => (
                          <span class="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-surface-raised-base text-10-regular text-text-base flex items-center justify-center ring-1 ring-background-base">
                            {badge()}
                          </span>
                        )}
                      </Show>
                    </button>
                  </Tooltip>
                )}
              </For>
            </Show>
          )
        }}
      </For>
    </div>
  )
}
