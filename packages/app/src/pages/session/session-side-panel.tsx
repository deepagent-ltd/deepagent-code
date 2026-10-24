import {
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type ComponentProps,
  type JSX,
} from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { Tabs } from "@deepagent-code/ui/tabs"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { Icon } from "@deepagent-code/ui/icon"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { ResizeHandle } from "@deepagent-code/ui/resize-handle"
import type { SnapshotFileDiff, VcsFileDiff } from "@deepagent-code/sdk"
import { type RightPanelWidthBucket } from "@/context/layout"
import { usePlatform } from "@/context/platform"

import FileTree from "@/components/file-tree"
import { useCommand } from "@/context/command"
import { useDebug } from "@/context/debug"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { createOpenSessionFileTab, createSessionTabs, type Sizing } from "@/pages/session/helpers"
import { IdeFileEditor } from "@/pages/session/ide-file-editor"
import { setSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import { SidePanelBrowser } from "@/pages/session/side-panel-browser"
import { SidePanelWorktree } from "@/pages/session/side-panel-worktree"
import { SidePanelDev } from "@/pages/session/side-panel-dev"
import { SidePanelProfile } from "./side-panel-profile"
import { SidePanelContext } from "./side-panel-context"
import { SidePanelIM } from "@/pages/session/side-panel-im"
import { SidePanelDockHeader, SidePanelTerminal, SidePanelDebugConsole } from "@/pages/session/side-panel-terminal"
import { ProblemsPanel } from "@/pages/session/problems-panel"
import { WorkPanelHome } from "./work-panel-home"
import { TaskProgressDetails } from "./task-progress"
import { WorkPanelTabs } from "./work-panel-tabs"
import type { WorkPanelView } from "@/context/work-panel-state"

type RenderDiff = (SnapshotFileDiff & { file: string }) | VcsFileDiff

// T3.1 — the single source of truth for the right-panel entries. Every panel is one row here; the memo
// boolean, the click handler, the rail button, and the content <Switch> arm are all DERIVED from this
// list, so adding a panel means adding ONE entry (not editing 5 parallel places as before). T3.3 adds
// `group` (rail sectioning) and `bucket` (which remembered width this panel uses).
type PanelMode =
  | "home"
  | "review"
  | "files"
  | "subagents"
  | "im"
  | "browser"
  | "worktree"
  | "dev"
  | "profile"
  | "context"
  | "terminal"
  | "debug-console"
  | "problems"

type PanelGroup = "code" | "agents" | "env" | "dev" | "dock"

// Phase 3: terminal is now side-native and always visible in the rail.
// Only debug-console and problems are still movable dock views.

type PanelDef = {
  readonly mode: PanelMode
  readonly icon: ComponentProps<typeof Icon>["name"]
  readonly titleKey: string
  readonly group: PanelGroup
  // Wide panels (diff/files) get the wide remembered width; everything else the narrow one (T3.3).
  readonly bucket: RightPanelWidthBucket
  // Keybind command id (rendered on the rail tooltip), if any.
  readonly keybind?: string
}

// Order = rail order. Groups are contiguous so the rail can draw a divider between them.
const PANELS: readonly PanelDef[] = [
  { mode: "home", icon: "link", titleKey: "workPanel.home", group: "code", bucket: "wide" },
  // Code
  {
    mode: "review",
    icon: "review",
    titleKey: "session.tab.review",
    group: "code",
    bucket: "wide",
    keybind: "review.toggle",
  },
  {
    mode: "files",
    icon: "file-tree",
    titleKey: "settings.general.row.showFileTree.title",
    group: "code",
    bucket: "wide",
    keybind: "fileTree.toggle",
  },
  // Agents — subagents is now the unified "子Agent监督" entry (Phase 2: oversight merged in).
  { mode: "subagents", icon: "agent-tree", titleKey: "session.subagents.title", group: "agents", bucket: "narrow" },
  { mode: "im", icon: "bubble-5", titleKey: "session.tab.im", group: "agents", bucket: "narrow" },
  // Env — browser is registered on the desktop build only (see `panels()` below).
  { mode: "browser", icon: "window-cursor", titleKey: "browser.title", group: "env", bucket: "wide" },
  { mode: "worktree", icon: "branch", titleKey: "worktree.title", group: "env", bucket: "narrow" },
  // Dev — WS1: debug + profiler + context-evidence merged into one tabbed panel. Plugins moved
  // to a Settings tab; Usage & cost moved into the SessionContextUsage dialog.
  { mode: "dev", icon: "debug", titleKey: "session.panel.debug", group: "dev", bucket: "narrow" },
  { mode: "profile", icon: "profile", titleKey: "session.panel.profile", group: "dev", bucket: "narrow" },
  { mode: "context", icon: "brain", titleKey: "session.context.title", group: "dev", bucket: "narrow" },
  // Dock — the movable panels; only surface here when docked to the side (see gating below).
  {
    mode: "terminal",
    icon: "terminal-active",
    titleKey: "session.panel.terminal",
    group: "dock",
    bucket: "narrow",
    keybind: "terminal.toggle",
  },
  {
    mode: "debug-console",
    icon: "code-lines",
    titleKey: "session.panel.debugConsole",
    group: "dock",
    bucket: "narrow",
  },
  { mode: "problems", icon: "warning", titleKey: "session.panel.problems", group: "dock", bucket: "narrow" },
]

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
  const platform = usePlatform()
  const sync = useSync()
  const sdk = useSDK()
  const dialog = useDialog()
  const { params, sessionKey, tabs, view } = useSessionLayout()
  const settings = { disposed: false, generation: 0 }
  onCleanup(() => {
    settings.disposed = true
  })
  const manageIM = async () => {
    const generation = ++settings.generation
    const directory = sdk.directory
    const scope = sdk.scope
    const current = () =>
      !settings.disposed && settings.generation === generation && sdk.directory === directory && sdk.scope === scope
    const { DialogSettings } = await import("@/components/settings-v2")
    if (!current() || view().rightPanel.mode() !== "im") return
    dialog.show(() => <DialogSettings initialTab="im" mcp={{ directory, current }} />)
  }

  const isDesktop = createMediaQuery("(min-width: 768px)")

  // WS1: the browser rail entry is registered on the desktop build only — its content is an
  // Electron WebContentsView bridge (platform.browser), so on web there is nothing to show.
  const panels = createMemo(() => PANELS.filter((p) => p.mode !== "browser" || platform.platform === "desktop"))

  // Narrow windows share the same IM panel and selection as the desktop rail.
  // Other tools retain their existing desktop layout.
  const activeMode = createMemo<PanelMode | undefined>(() => {
    const mode = view().rightPanel.mode()
    if (!isDesktop() && mode !== "im") return undefined
    return mode && panels().some((p) => p.mode === mode) ? (mode as PanelMode) : undefined
  })
  const isActive = (mode: PanelMode) => activeMode() === mode
  const open = createMemo(() => activeMode() !== undefined)
  // Per-panel remembered width (T3.3): the wide bucket for diff/files, the narrow bucket for the rest.
  const activeBucket = createMemo<RightPanelWidthBucket>(
    () => panels().find((p) => p.mode === activeMode())?.bucket ?? "wide",
  )
  const contentWidth = createMemo(() =>
    view().workPanel.expanded() ? layout.rightPanel.maxWidth() : layout.rightPanel.width(activeBucket()),
  )
  const panelWidth = createMemo(() =>
    !isDesktop() || (open() && view().workPanel.expanded()) ? "100%" : open() ? `${contentWidth()}px` : "0px",
  )

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
    if (!s || !s.name.trim()) {
      cancelNewItem()
      return
    }
    const name = s.name.trim()
    cancelNewItem()
    if (s.type === "file") {
      const res = await file.createFile(name)
      if (!res.ok) {
        const { showToast } = await import("@/utils/toast")
        showToast({
          variant: "error",
          title: language.t("session.files.create.failed"),
          description: res.error ?? "unknown",
        })
      } else {
        void file.load(name)
      }
    } else {
      const res = await file.mkdir(name)
      if (!res.ok) {
        const { showToast } = await import("@/utils/toast")
        showToast({
          variant: "error",
          title: language.t("session.files.createFolder.failed"),
          description: res.error ?? "unknown",
        })
      }
    }
  }

  const fileTreeTab = () => layout.fileTree.tab()

  const setFileTreeTabValue = (value: string) => {
    if (value !== "changes" && value !== "all") return
    layout.fileTree.setTab(value)
  }

  const closePanel = () => view().rightPanel.close()

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
    <Show when={isDesktop() || isActive("im")}>
      {/* T3.2 — aside = a fixed, always-on icon RAIL + an animated CONTENT region. The rail is always
          interactive (it's the switcher); only the content region collapses to 0 width when closed. */}
      <aside
        id="review-panel"
        aria-label={language.t(isDesktop() ? "session.panel.reviewAndFiles" : "session.tab.im")}
        data-prevent-autofocus
        class="relative min-w-0 min-h-0 h-full flex shrink-0"
        classList={{ "flex-1 w-full": !isDesktop() || (open() && view().workPanel.expanded()) }}
        style={{ gap: isDesktop() && open() ? "var(--workbench-gap)" : undefined }}
      >
        <div
          class="workbench-panel relative min-w-0 h-full overflow-hidden"
          aria-hidden={!open()}
          inert={!open()}
          classList={{
            "pointer-events-none": !open(),
            "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
              isDesktop() && !props.size.active() && !props.reviewSnap,
          }}
          style={{ width: panelWidth() }}
        >
          <Show when={open()}>
            <div class="size-full flex">
              <Show when={isDesktop() && !view().workPanel.expanded()}>
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
              </Show>
              <div class="size-full min-w-0 flex flex-col">
                <WorkPanelTabs
                  compact={!isDesktop()}
                  tabs={view().workPanel.tabs()}
                  active={view().workPanel.active()?.id}
                  expanded={view().workPanel.expanded()}
                  title={(tab: WorkPanelView) =>
                    tab.kind === "subagents"
                      ? language.t("workPanel.tasks" as Parameters<typeof language.t>[0])
                      : tab.kind === "browser" && tab.resourceID
                        ? `${language.t("browser.title")} ${
                            view()
                              .workPanel.tabs()
                              .filter((item) => item.kind === "browser" && item.resourceID)
                              .findIndex((item) => item.id === tab.id) + 1
                          }`
                        : language.t(panels().find((panel) => panel.mode === tab.kind)?.titleKey ?? "workPanel.home")
                  }
                  focus={(id) => view().workPanel.focus(id)}
                  close={(id) => view().workPanel.closeView(id)}
                  home={() => view().workPanel.open("home")}
                  expand={() => view().workPanel.setExpanded(!view().workPanel.expanded())}
                  hide={closePanel}
                />
                <div class="min-h-0 flex-1 overflow-hidden">
                  <Switch>
                    <Match when={isActive("home")}>
                      <WorkPanelHome
                        sessionID={params.id}
                        directory={sdk.directory}
                        open={(kind, options) => {
                          if (kind === "browser") view().rightPanel.selectSharedBrowser(options?.resourceID)
                          if (kind === "files") layout.fileTree.setTab("all")
                          view().workPanel.open(kind, options)
                        }}
                      />
                    </Match>
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
                                    props.reviewCount() === 1
                                      ? "session.review.change.one"
                                      : "session.review.change.other",
                                  )}
                                </Tabs.Trigger>
                                <Tabs.Trigger value="all" class="flex-1" classes={{ button: "w-full" }}>
                                  {language.t("session.files.all")}
                                </Tabs.Trigger>
                              </Tabs.List>
                              <Tabs.Content value="changes" class="px-3 py-0">
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
                              <Tabs.Content value="all" class="px-3 py-0">
                                {/* V3.6 Phase 1B F5: file ops toolbar */}
                                <div class="flex items-center gap-1 py-1.5 -mx-3 px-3 border-b border-border-weaker-base">
                                  <span class="flex-1 text-12-regular text-text-weak">
                                    {language.t("session.files.heading")}
                                  </span>
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
                      <TaskProgressDetails />
                    </Match>
                    <Match when={isActive("browser")}>
                      <SidePanelBrowser
                        onClose={closePanel}
                        sessionID={params.id}
                        directory={sdk.directory}
                        selection={
                          view().workPanel.active()?.resourceID
                            ? {
                                resourceID: view().workPanel.active()!.resourceID!,
                                nonce: view().workPanel.active()!.id,
                              }
                            : undefined
                        }
                        personal={!view().workPanel.active()?.resourceID}
                        hideTabs
                        onSelectResource={(resourceID) => {
                          view().rightPanel.selectSharedBrowser(resourceID)
                          if (resourceID) view().workPanel.open("browser", { resourceID })
                        }}
                      />
                    </Match>
                    <Match when={isActive("worktree")}>
                      <SidePanelWorktree onClose={closePanel} />
                    </Match>
                    <Match when={isActive("dev")}>
                      <SidePanelDev standalone onClose={closePanel} onNavigate={openFileAt} />
                    </Match>
                    <Match when={isActive("profile")}>
                      <SidePanelProfile onClose={closePanel} />
                    </Match>
                    <Match when={isActive("context")}>
                      <SidePanelContext onClose={closePanel} />
                    </Match>
                    <Match when={isActive("im")}>
                      <SidePanelIM onClose={closePanel} chromeOwned={isDesktop()} onManageIM={() => void manageIM()} />
                    </Match>
                    <Match when={isActive("terminal")}>
                      <SidePanelTerminal onClose={() => view().rightPanel.close()} />
                    </Match>
                    <Match when={isActive("debug-console")}>
                      <SidePanelDebugConsole onClose={closePanel} />
                    </Match>
                    <Match when={isActive("problems")}>
                      <div class="h-full w-full min-w-0 flex flex-col overflow-hidden bg-background-base">
                        <SidePanelDockHeader
                          id="problems"
                          title={language.t("session.panel.problems")}
                          onClose={closePanel}
                        />
                        <div class="flex-1 min-h-0">
                          <ProblemsPanel active={() => isActive("problems")} onOpenFile={openFileAt} />
                        </div>
                      </div>
                    </Match>
                  </Switch>
                </div>
              </div>
            </div>
          </Show>
        </div>
      </aside>
    </Show>
  )
}
