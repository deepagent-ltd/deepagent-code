import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal, batch, type ComponentProps, type JSX } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { Tabs } from "@deepagent-code/ui/tabs"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { Icon } from "@deepagent-code/ui/icon"
import { Keybind } from "@deepagent-code/ui/keybind"
import { ResizeHandle } from "@deepagent-code/ui/resize-handle"
import type { SnapshotFileDiff, VcsFileDiff } from "@deepagent-code/sdk/v2"

import FileTree from "@/components/file-tree"
import { SidePanelPlugins } from "@/pages/session/side-panel-plugins"
import { useCommand } from "@/context/command"
import { useDebug } from "@/context/debug"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { fetchCapabilities } from "@/components/deepagent/panel-goal.api"
import { useTerminal } from "@/context/terminal"
import { createOpenSessionFileTab, createSessionTabs, focusTerminalById, type Sizing } from "@/pages/session/helpers"
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

type RenderDiff = (SnapshotFileDiff & { file: string }) | VcsFileDiff
type SidePanelItem = {
  icon: ComponentProps<typeof Icon>["name"]
  title: string
  keybind?: string
  badge?: string
  active: boolean
  onClick: () => void
}

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
}) {
  const layout = useLayout()
  const file = useFile()
  const debug = useDebug()
  const language = useLanguage()
  const command = useCommand()
  const terminal = useTerminal()
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

  const menuOpen = createMemo(() => isDesktop() && view().rightPanel.mode() === "menu")
  const reviewOpen = createMemo(() => isDesktop() && view().rightPanel.mode() === "review")
  const fileOpen = createMemo(() => isDesktop() && view().rightPanel.mode() === "files")
  const subagentsOpen = createMemo(() => isDesktop() && view().rightPanel.mode() === "subagents")
  const browserOpen = createMemo(() => isDesktop() && view().rightPanel.mode() === "browser")
  const worktreeOpen = createMemo(() => isDesktop() && view().rightPanel.mode() === "worktree")
  const pluginsOpen = createMemo(() => isDesktop() && view().rightPanel.mode() === "plugins")
  const debugOpen = createMemo(() => isDesktop() && view().rightPanel.mode() === "debug")
  const profileOpen = createMemo(() => isDesktop() && view().rightPanel.mode() === "profile")
  const imOpen = createMemo(() => isDesktop() && view().rightPanel.mode() === "im")
  const oversightOpen = createMemo(() => isDesktop() && view().rightPanel.mode() === "oversight")
  const open = createMemo(
    () =>
      menuOpen() ||
      reviewOpen() ||
      fileOpen() ||
      subagentsOpen() ||
      browserOpen() ||
      worktreeOpen() ||
      pluginsOpen() ||
      debugOpen() ||
      profileOpen() ||
      imOpen() ||
      oversightOpen(),
  )
  const panelWidth = createMemo(() => (open() ? `${layout.rightPanel.width()}px` : "0px"))

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

  const openMenu = () => {
    view().reviewPanel.close()
    layout.fileTree.close()
    view().rightPanel.open("menu")
  }

  const openReview = () => {
    view().reviewPanel.close()
    layout.fileTree.close()
    view().rightPanel.open("review")
  }

  const openFiles = () => {
    view().reviewPanel.close()
    layout.fileTree.close()
    view().rightPanel.open("files")
  }

  const openSubagents = () => {
    view().reviewPanel.close()
    layout.fileTree.close()
    view().rightPanel.open("subagents")
  }

  const openBrowser = () => {
    view().reviewPanel.close()
    layout.fileTree.close()
    view().rightPanel.open("browser")
  }

  const openWorktree = () => {
    view().reviewPanel.close()
    layout.fileTree.close()
    view().rightPanel.open("worktree")
  }

  const openPlugins = () => {
    view().reviewPanel.close()
    layout.fileTree.close()
    view().rightPanel.open("plugins")
  }

  const openDebug = () => {
    view().reviewPanel.close()
    layout.fileTree.close()
    view().rightPanel.open("debug")
  }

  const openProfile = () => {
    view().reviewPanel.close()
    layout.fileTree.close()
    view().rightPanel.open("profile")
  }

  const openIM = () => {
    view().reviewPanel.close()
    layout.fileTree.close()
    view().rightPanel.open("im")
  }

  const openOversight = () => {
    view().reviewPanel.close()
    layout.fileTree.close()
    view().rightPanel.open("oversight")
  }

  const openTerminal = () => {
    view().terminal.open()
    queueMicrotask(() => {
      const id = terminal.active()
      if (id) focusTerminalById(id)
    })
  }

  // V3.6 Phase 3B: removed duplicate "terminal" and "status/servers-MCP" entries.
  // Both already appear as titlebar buttons (title-bar right: terminal toggle + StatusPopover).
  // Keeping them here created confusing dual entry-points for the same functionality (S1).
  const menuItems = createMemo<SidePanelItem[]>(() => [
    {
      icon: "review",
      title: language.t("session.tab.review"),
      keybind: command.keybind("review.toggle"),
      badge: props.hasReview() ? String(props.reviewCount()) : undefined,
      active: reviewOpen(),
      onClick: openReview,
    },
    {
      icon: "file-tree",
      title: language.t("settings.general.row.showFileTree.title"),
      keybind: command.keybind("fileTree.toggle"),
      active: fileOpen(),
      onClick: openFiles,
    },
    {
      icon: "task",
      title: language.t("session.subagents.title"),
      badge: runningSubagentCount() > 0 ? String(runningSubagentCount()) : undefined,
      active: subagentsOpen(),
      onClick: openSubagents,
    },
    {
      icon: "bubble-5",
      title: language.t("session.tab.im"),
      active: imOpen(),
      onClick: openIM,
    },
    // T1.1: Oversight only when its Approval-Queue producers can actually run (v4MultiAgentRuntime).
    ...(oversightEnabled()
      ? [
          {
            icon: "shield" as const,
            title: language.t("session.panel.oversight"),
            active: oversightOpen(),
            onClick: openOversight,
          },
        ]
      : []),
    {
      icon: "link",
      title: language.t("browser.title"),
      active: browserOpen(),
      onClick: openBrowser,
    },
    {
      icon: "branch",
      title: language.t("worktree.title"),
      active: worktreeOpen(),
      onClick: openWorktree,
    },
    {
      icon: "dot-grid",
      // V3.6 Phase 3C: renamed from "Plugins" to "Extensions & Services" (sidebar.extensions)
      title: language.t("sidebar.extensions"),
      active: pluginsOpen(),
      onClick: openPlugins,
    },
    {
      icon: "terminal",
      title: language.t("session.panel.debug"),
      active: debugOpen(),
      onClick: openDebug,
    },
    {
      icon: "status",
      title: language.t("session.panel.profile"),
      active: profileOpen(),
      onClick: openProfile,
    },
  ])

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
    <Show when={isDesktop()}>
      <aside
        id="review-panel"
        aria-label={language.t("session.panel.reviewAndFiles")}
        aria-hidden={!open()}
        inert={!open()}
        class="relative min-w-0 h-full flex shrink-0 overflow-hidden bg-background-base"
        classList={{
          "pointer-events-none": !open(),
          "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
            !props.size.active() && !props.reviewSnap,
        }}
        style={{ width: panelWidth() }}
      >
        <Show when={open()}>
          <div class="size-full flex border-l border-border-weaker-base">
            <div onPointerDown={() => props.size.start()}>
              <ResizeHandle
                direction="horizontal"
                edge="start"
                size={layout.rightPanel.width()}
                min={layout.rightPanel.minWidth}
                max={layout.rightPanel.maxWidth()}
                onResize={(width) => {
                  props.size.touch()
                  layout.rightPanel.resize(width)
                }}
              />
            </div>
            <Switch>
              <Match when={menuOpen()}>
                <SidePanelMenu items={menuItems} onClose={view().rightPanel.close} />
              </Match>
              <Match when={reviewOpen()}>
                <div class="h-full w-full min-w-0 overflow-hidden bg-background-base">{props.reviewPanel()}</div>
              </Match>
              <Match when={fileOpen()}>
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
              <Match when={subagentsOpen()}>
                <SidePanelSubagents onClose={openMenu} />
              </Match>
              <Match when={browserOpen()}>
                <SidePanelBrowser onClose={openMenu} />
              </Match>
              <Match when={worktreeOpen()}>
                <SidePanelWorktree onClose={openMenu} />
              </Match>
              <Match when={pluginsOpen()}>
                <SidePanelPlugins onClose={openMenu} />
              </Match>
              <Match when={debugOpen()}>
                <SidePanelDebug onClose={openMenu} onNavigate={openFileAt} />
              </Match>
              <Match when={profileOpen()}>
                <SidePanelProfile onClose={openMenu} />
              </Match>
              <Match when={imOpen()}>
                <SidePanelIM onClose={openMenu} />
              </Match>
              <Match when={oversightOpen()}>
                <SidePanelOversight onClose={openMenu} />
              </Match>
            </Switch>
          </div>
        </Show>
      </aside>
    </Show>
  )
}

function SidePanelMenu(props: { items: () => SidePanelItem[]; onClose: () => void }) {
  const language = useLanguage()

  return (
    <div class="h-full w-full min-w-0 bg-background-base">
      <div class="sticky top-0 z-10 h-10 flex items-center justify-end px-2 bg-background-base">
        <IconButton
          icon="close-small"
          variant="ghost"
          class="h-7 w-7 rounded-md"
          onClick={props.onClose}
          aria-label={language.t("common.close")}
        />
      </div>
      {/* Scrollable so items stay reachable when the bottom terminal shortens the
          sidebar. Center vertically only while there's spare room (justify-center on
          a min-h-full inner track); once items overflow, scrolling takes over. */}
      <div class="h-[calc(100%-40px)] min-h-0 overflow-y-auto">
        <div class="min-h-full w-full px-4 py-2 flex flex-col justify-center gap-2">
          <For each={props.items()}>
            {(item) => (
              <button
                type="button"
                class="group h-14 w-full rounded-lg px-4 flex items-center gap-3 text-left transition-colors bg-surface-base hover:bg-surface-raised-base-hover"
                classList={{
                  "ring-1 ring-border-strong-base bg-surface-raised-base-active": item.active,
                }}
                onClick={item.onClick}
              >
                <Icon name={item.icon} size="small" class="text-icon-base shrink-0" />
                <span class="min-w-0 flex-1 text-15-medium text-text-strong truncate">{item.title}</span>
                <Show when={item.badge}>
                  {(badge) => (
                    <span class="min-w-5 h-5 px-1.5 rounded-full bg-surface-raised-base text-11-medium text-text-base flex items-center justify-center">
                      {badge()}
                    </span>
                  )}
                </Show>
                <Show when={item.keybind}>
                  {(keybind) => (
                    <Keybind class="shrink-0 !border-0 !shadow-none bg-surface-raised-base text-text-weaker">
                      {keybind()}
                    </Keybind>
                  )}
                </Show>
              </button>
            )}
          </For>
        </div>
      </div>
    </div>
  )
}
