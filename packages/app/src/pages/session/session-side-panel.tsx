import { For, Match, Show, Switch, createEffect, createMemo, type ComponentProps, type JSX } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { Tabs } from "@deepagent-code/ui/tabs"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { Icon } from "@deepagent-code/ui/icon"
import { Keybind } from "@deepagent-code/ui/keybind"
import { ResizeHandle } from "@deepagent-code/ui/resize-handle"
import type { SnapshotFileDiff, VcsFileDiff } from "@deepagent-code/sdk/v2"

import FileTree from "@/components/file-tree"
import { StatusPopoverBody } from "@/components/status-popover-body"
import { SidePanelPlugins } from "@/pages/session/side-panel-plugins"
import { useCommand } from "@/context/command"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useTerminal } from "@/context/terminal"
import { createOpenSessionFileTab, focusTerminalById, type Sizing } from "@/pages/session/helpers"
import { setSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import { SidePanelSubagents } from "@/pages/session/side-panel-subagents"
import { SidePanelBrowser } from "@/pages/session/side-panel-browser"
import { SidePanelWorktree } from "@/pages/session/side-panel-worktree"

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
  const language = useLanguage()
  const command = useCommand()
  const terminal = useTerminal()
  const { sessionKey, tabs, view } = useSessionLayout()

  const isDesktop = createMediaQuery("(min-width: 768px)")

  const menuOpen = createMemo(() => isDesktop() && view().rightPanel.mode() === "menu")
  const reviewOpen = createMemo(() => isDesktop() && view().rightPanel.mode() === "review")
  const fileOpen = createMemo(() => isDesktop() && view().rightPanel.mode() === "files")
  const statusOpen = createMemo(() => isDesktop() && view().rightPanel.mode() === "status")
  const subagentsOpen = createMemo(() => isDesktop() && view().rightPanel.mode() === "subagents")
  const browserOpen = createMemo(() => isDesktop() && view().rightPanel.mode() === "browser")
  const worktreeOpen = createMemo(() => isDesktop() && view().rightPanel.mode() === "worktree")
  const pluginsOpen = createMemo(() => isDesktop() && view().rightPanel.mode() === "plugins")
  const open = createMemo(
    () =>
      menuOpen() ||
      reviewOpen() ||
      fileOpen() ||
      statusOpen() ||
      subagentsOpen() ||
      browserOpen() ||
      worktreeOpen() ||
      pluginsOpen(),
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

  const openReviewPanel = () => {
    view().rightPanel.open("review")
  }

  const openTab = createOpenSessionFileTab({
    normalizeTab,
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    openReviewPanel,
    setActive: tabs().setActive,
  })

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

  const openStatus = () => {
    view().reviewPanel.close()
    layout.fileTree.close()
    view().rightPanel.open("status")
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

  const openTerminal = () => {
    view().terminal.open()
    queueMicrotask(() => {
      const id = terminal.active()
      if (id) focusTerminalById(id)
    })
  }

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
      icon: "terminal",
      title: language.t("terminal.title"),
      keybind: command.keybind("terminal.toggle"),
      active: view().terminal.opened(),
      onClick: openTerminal,
    },
    {
      icon: "file-tree",
      title: language.t("settings.general.row.showFileTree.title"),
      keybind: command.keybind("fileTree.toggle"),
      active: fileOpen(),
      onClick: openFiles,
    },
    {
      icon: "status",
      title: language.t("status.popover.trigger"),
      active: statusOpen(),
      onClick: openStatus,
    },
    {
      icon: "task",
      title: language.t("session.subagents.title"),
      active: subagentsOpen(),
      onClick: openSubagents,
    },
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
      title: language.t("status.popover.tab.plugins"),
      active: pluginsOpen(),
      onClick: openPlugins,
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
                      <Switch>
                        <Match when={nofiles()}>{empty(language.t("session.files.empty"))}</Match>
                        <Match when={true}>
                          <FileTree
                            path=""
                            class="pt-3"
                            modified={diffFiles()}
                            kinds={kinds()}
                            onFileClick={(node) => openTab(file.tab(node.path))}
                          />
                        </Match>
                      </Switch>
                    </Tabs.Content>
                  </Tabs>
                </div>
              </Match>
              <Match when={statusOpen()}>
                <div class="h-full w-full min-w-0 overflow-y-auto bg-background-base">
                  <div class="sticky top-0 z-10 h-10 flex items-center justify-end px-2 bg-background-base">
                    <IconButton
                      icon="close-small"
                      variant="ghost"
                      class="h-7 w-7 rounded-md"
                      onClick={openMenu}
                      aria-label={language.t("common.close")}
                    />
                  </div>
                  <div class="[&>div]:!w-full [&>div]:!rounded-none [&>div]:!shadow-none [&_.tabs]:!rounded-none [&_.tabs]:!bg-background-base">
                    <StatusPopoverBody shown={statusOpen} />
                  </div>
                </div>
              </Match>
              <Match when={subagentsOpen()}>
                <SidePanelSubagents sessionID={sessionKey()} onClose={openMenu} />
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
      <div class="h-[calc(100%-40px)] min-h-0 flex items-center">
        <div class="w-full px-4 flex flex-col gap-2">
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
