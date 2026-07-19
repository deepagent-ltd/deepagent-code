import { AppIcon } from "@deepagent-code/ui/app-icon"
import { Button } from "@deepagent-code/ui/button"
import { DropdownMenu } from "@deepagent-code/ui/dropdown-menu"
import { Popover } from "@deepagent-code/ui/popover"
import { Icon } from "@deepagent-code/ui/icon"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { Keybind } from "@deepagent-code/ui/keybind"
import { Spinner } from "@deepagent-code/ui/spinner"
import { showToast } from "@/utils/toast"
import { Tooltip, TooltipKeybind } from "@deepagent-code/ui/tooltip"
import { getFilename } from "@deepagent-code/core/util/path"
import { createEffect, createMemo, createSignal, For, onMount, Show, type ComponentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { DOCK_PANEL_IDS, useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { useTerminal } from "@/context/terminal"
import { focusTerminalById } from "@/pages/session/helpers"
import { useSessionLayout } from "@/pages/session/session-layout"
import { PANEL_VIEW_META } from "@/pages/session/panel-view-registry"
import { StatusPopover } from "@/components/status-popover"
import { messageAgentColor } from "@/utils/agent"
import { decode64 } from "@/utils/base64"
import { Persist, persisted } from "@/utils/persist"

const OPEN_APPS = [
  "vscode",
  "cursor",
  "zed",
  "textmate",
  "antigravity",
  "finder",
  "terminal",
  "iterm2",
  "ghostty",
  "warp",
  "xcode",
  "android-studio",
  "powershell",
  "sublime-text",
] as const

type OpenApp = (typeof OPEN_APPS)[number]
type OpenAppIcon = ComponentProps<typeof AppIcon>["id"]
type OpenAppOption = {
  id: OpenApp
  label: string
  icon: OpenAppIcon
  openWith?: string
}
type OS = "macos" | "windows" | "linux" | "unknown"

const MAC_APPS = [
  {
    id: "vscode",
    label: "session.header.open.app.vscode",
    icon: "vscode",
    openWith: "Visual Studio Code",
  },
  { id: "cursor", label: "session.header.open.app.cursor", icon: "cursor", openWith: "Cursor" },
  { id: "zed", label: "session.header.open.app.zed", icon: "zed", openWith: "Zed" },
  { id: "textmate", label: "session.header.open.app.textmate", icon: "textmate", openWith: "TextMate" },
  {
    id: "antigravity",
    label: "session.header.open.app.antigravity",
    icon: "antigravity",
    openWith: "Antigravity",
  },
  { id: "terminal", label: "session.header.open.app.terminal", icon: "terminal", openWith: "Terminal" },
  { id: "iterm2", label: "session.header.open.app.iterm2", icon: "iterm2", openWith: "iTerm" },
  { id: "ghostty", label: "session.header.open.app.ghostty", icon: "ghostty", openWith: "Ghostty" },
  { id: "warp", label: "session.header.open.app.warp", icon: "warp", openWith: "Warp" },
  { id: "xcode", label: "session.header.open.app.xcode", icon: "xcode", openWith: "Xcode" },
  {
    id: "android-studio",
    label: "session.header.open.app.androidStudio",
    icon: "android-studio",
    openWith: "Android Studio",
  },
  {
    id: "sublime-text",
    label: "session.header.open.app.sublimeText",
    icon: "sublime-text",
    openWith: "Sublime Text",
  },
] as const

const WINDOWS_APPS = [
  { id: "vscode", label: "session.header.open.app.vscode", icon: "vscode", openWith: "code" },
  { id: "cursor", label: "session.header.open.app.cursor", icon: "cursor", openWith: "cursor" },
  { id: "zed", label: "session.header.open.app.zed", icon: "zed", openWith: "zed" },
  {
    id: "powershell",
    label: "session.header.open.app.powershell",
    icon: "powershell",
    openWith: "powershell",
  },
  {
    id: "sublime-text",
    label: "session.header.open.app.sublimeText",
    icon: "sublime-text",
    openWith: "Sublime Text",
  },
] as const

const LINUX_APPS = [
  { id: "vscode", label: "session.header.open.app.vscode", icon: "vscode", openWith: "code" },
  { id: "cursor", label: "session.header.open.app.cursor", icon: "cursor", openWith: "cursor" },
  { id: "zed", label: "session.header.open.app.zed", icon: "zed", openWith: "zed" },
  {
    id: "sublime-text",
    label: "session.header.open.app.sublimeText",
    icon: "sublime-text",
    openWith: "Sublime Text",
  },
] as const

const detectOS = (platform: ReturnType<typeof usePlatform>): OS => {
  if (platform.platform === "desktop" && platform.os) return platform.os
  if (typeof navigator !== "object") return "unknown"
  const value = navigator.platform || navigator.userAgent
  if (/Mac/i.test(value)) return "macos"
  if (/Win/i.test(value)) return "windows"
  if (/Linux/i.test(value)) return "linux"
  return "unknown"
}

const showRequestError = (language: ReturnType<typeof useLanguage>, err: unknown) => {
  showToast({
    variant: "error",
    title: language.t("common.requestFailed"),
    description: err instanceof Error ? err.message : String(err),
  })
}

export function SessionHeader() {
  const layout = useLayout()
  const command = useCommand()
  const server = useServer()
  const platform = usePlatform()
  const language = useLanguage()
  const sync = useSync()
  const terminal = useTerminal()
  const { params, view } = useSessionLayout()

  const projectDirectory = createMemo(() => decode64(params.dir) ?? "")
  const project = createMemo(() => {
    const directory = projectDirectory()
    if (!directory) return
    return layout.projects.list().find((p) => p.worktree === directory || p.sandboxes?.includes(directory))
  })
  const name = createMemo(() => {
    const current = project()
    if (current) return current.name || getFilename(current.worktree)
    return getFilename(projectDirectory())
  })
  const hotkey = createMemo(() => command.keybind("file.open"))
  const os = createMemo(() => detectOS(platform))
  const search = () => true
  const term = () => true

  const [exists, setExists] = createStore<Partial<Record<OpenApp, boolean>>>({
    finder: true,
  })

  const apps = createMemo(() => {
    if (os() === "macos") return MAC_APPS
    if (os() === "windows") return WINDOWS_APPS
    return LINUX_APPS
  })

  const fileManager = createMemo(() => {
    if (os() === "macos") return { label: "session.header.open.finder", icon: "finder" as const }
    if (os() === "windows") return { label: "session.header.open.fileExplorer", icon: "file-explorer" as const }
    return { label: "session.header.open.fileManager", icon: "finder" as const }
  })

  createEffect(() => {
    if (platform.platform !== "desktop") return
    if (!platform.checkAppExists) return

    const list = apps()

    setExists(Object.fromEntries(list.map((app) => [app.id, undefined])) as Partial<Record<OpenApp, boolean>>)

    void Promise.all(
      list.map((app) =>
        Promise.resolve(platform.checkAppExists?.(app.openWith))
          .then((value) => Boolean(value))
          .catch(() => false)
          .then((ok) => [app.id, ok] as const),
      ),
    ).then((entries) => {
      setExists(Object.fromEntries(entries) as Partial<Record<OpenApp, boolean>>)
    })
  })

  const options = createMemo<OpenAppOption[]>(() => {
    return [
      { id: "finder", label: language.t(fileManager().label), icon: fileManager().icon },
      ...apps()
        .filter((app) => exists[app.id])
        .map((app) => ({ id: app.id, label: language.t(app.label), icon: app.icon, openWith: app.openWith })),
    ]
  })

  const terminalOpen = createMemo(() => {
    const panel = view().panel
    return panel.location("terminal") === "bottom"
      ? panel.bottom.opened() && panel.bottom.activeView() === "terminal"
      : view().rightPanel.mode() === "terminal"
  })

  const toggleTerminal = () => {
    view().panel.toggle("terminal")
    const panel = view().panel
    if (panel.location("terminal") === "side" && view().rightPanel.mode() !== "terminal") return
    const id = terminal.active()
    if (id) focusTerminalById(id)
  }

  const bottomPanelOpen = createMemo(() => view().panel.bottom.opened())
  const bottomPanelAvailable = createMemo(() => view().panel.viewsAt("bottom").length > 0)
  const toggleBottomPanel = () => view().panel.bottom.toggle()
  const [panelViewsOpen, setPanelViewsOpen] = createSignal(false)
  const panelViewIDs = createMemo(() => [...DOCK_PANEL_IDS])
  const revealPanelView = (id: (typeof DOCK_PANEL_IDS)[number]) => {
    view().panel.reveal(id)
    setPanelViewsOpen(false)
  }
  const movePanelView = (id: (typeof DOCK_PANEL_IDS)[number], target: "bottom" | "side") => {
    view().panel.move(id, target)
    setPanelViewsOpen(false)
  }

  const rightPanelOpen = createMemo(() => view().rightPanel.opened())

  const toggleRightPanel = () => {
    if (rightPanelOpen()) {
      view().rightPanel.close()
      return
    }

    view().reviewPanel.close()
    layout.fileTree.close()
    // T3.2: the right panel now has an always-on icon rail; there is no separate "menu" list. Opening
    // the panel means opening a default content panel (review) — the rail lets the user switch from there.
    view().rightPanel.open("review")
  }

  const [prefs, setPrefs] = persisted(Persist.global("open.app"), createStore({ app: "finder" as OpenApp }))
  const [menu, setMenu] = createStore({ open: false })
  const [openRequest, setOpenRequest] = createStore({
    app: undefined as OpenApp | undefined,
  })

  const canOpen = createMemo(() => platform.platform === "desktop" && !!platform.openPath && server.isLocal())
  const current = createMemo(
    () =>
      options().find((o) => o.id === prefs.app) ??
      options()[0] ??
      ({ id: "finder", label: fileManager().label, icon: fileManager().icon } as const),
  )
  const opening = createMemo(() => openRequest.app !== undefined)
  const tint = createMemo(() =>
    messageAgentColor(params.id ? sync.data.message[params.id] : undefined, sync.data.agent),
  )
  // A running subagent (child session, parentID === current) puts a pulsing dot on the side-panel
  // toggle so the user sees a spawn happened without opening the Subagents panel first.
  const hasRunningSubagent = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.data.session.some((s) => s.parentID === id && sync.data.session_working(s.id))
  })
  const selectApp = (app: OpenApp) => {
    if (!options().some((item) => item.id === app)) return
    setPrefs("app", app)
  }

  const openDir = (app: OpenApp) => {
    if (opening() || !canOpen() || !platform.openPath) return
    const directory = projectDirectory()
    if (!directory) return

    const item = options().find((o) => o.id === app)
    setOpenRequest("app", app)
    platform
      .openPath(directory, item?.openWith)
      .catch((err: unknown) => showRequestError(language, err))
      .finally(() => {
        setOpenRequest("app", undefined)
      })
  }

  const copyPath = () => {
    const directory = projectDirectory()
    if (!directory) return
    navigator.clipboard
      .writeText(directory)
      .then(() => {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("session.share.copy.copied"),
          description: directory,
        })
      })
      .catch((err: unknown) => showRequestError(language, err))
  }

  const [centerMount, setCenterMount] = createSignal<HTMLElement | null>(null)
  const [rightMount, setRightMount] = createSignal<HTMLElement | null>(null)
  onMount(() => {
    setCenterMount(document.getElementById("deepagent-code-titlebar-center"))
    setRightMount(document.getElementById("deepagent-code-titlebar-right"))
  })

  return (
    <>
      <Show when={search() && centerMount()}>
        {(mount) => (
          <Portal mount={mount()}>
            <Button
              type="button"
              variant="ghost"
              size="small"
              class="hidden md:flex w-[240px] max-w-full min-w-0 items-center gap-2 justify-between rounded-md border border-border-weak-base bg-surface-panel shadow-none cursor-default"
              onClick={() => command.trigger("file.open")}
              aria-label={language.t("session.header.searchFiles")}
            >
              <div class="flex min-w-0 flex-1 items-center overflow-visible">
                <span class="flex-1 min-w-0 text-12-regular text-text-weak truncate text-left">
                  {language.t("session.header.search.placeholder", {
                    project: name(),
                  })}
                </span>
              </div>

              <Show when={hotkey()}>
                {(keybind) => (
                  <Keybind class="shrink-0 !border-0 !bg-transparent !shadow-none px-0 text-text-weaker">
                    {keybind()}
                  </Keybind>
                )}
              </Show>
            </Button>
          </Portal>
        )}
      </Show>
      <Show when={rightMount()}>
        {(mount) => (
          <Portal mount={mount()}>
            <div class="flex items-center gap-2">
              <Show when={projectDirectory()}>
                <div class="hidden xl:flex items-center">
                  <Show
                    when={canOpen()}
                    fallback={
                      <div class="flex h-[24px] box-border items-center rounded-md border border-border-weak-base bg-surface-panel overflow-hidden">
                        <Button
                          variant="ghost"
                          class="rounded-none h-full py-0 pr-3 pl-0.5 gap-1.5 border-none shadow-none"
                          onClick={copyPath}
                          aria-label={language.t("session.header.open.copyPath")}
                        >
                          <Icon name="copy" size="small" class="text-icon-base" />
                          <span class="text-12-regular text-text-strong">
                            {language.t("session.header.open.copyPath")}
                          </span>
                        </Button>
                      </div>
                    }
                  >
                    <div class="flex items-center">
                      <div class="flex h-[24px] box-border items-center rounded-md border border-border-weak-base bg-surface-panel overflow-hidden">
                        <Button
                          variant="ghost"
                          class="rounded-none h-full px-0.5 border-none shadow-none disabled:!cursor-default"
                          classList={{
                            "bg-surface-raised-base-active": opening(),
                          }}
                          onClick={() => openDir(current().id)}
                          disabled={opening()}
                          aria-label={language.t("session.header.open.ariaLabel", { app: current().label })}
                        >
                          <div class="flex size-5 shrink-0 items-center justify-center [&_[data-component=app-icon]]:size-5">
                            <Show when={opening()} fallback={<AppIcon id={current().icon} />}>
                              <Spinner class="size-3.5" style={{ color: tint() ?? "var(--icon-base)" }} />
                            </Show>
                          </div>
                        </Button>
                        <DropdownMenu
                          gutter={4}
                          placement="bottom-end"
                          open={menu.open}
                          onOpenChange={(open) => setMenu("open", open)}
                        >
                          <DropdownMenu.Trigger
                            as={IconButton}
                            icon="chevron-down"
                            variant="ghost"
                            disabled={opening()}
                            class="rounded-none h-full w-[20px] p-0 border-none shadow-none data-[expanded]:bg-surface-raised-base-active disabled:!cursor-default"
                            classList={{
                              "bg-surface-raised-base-active": opening(),
                            }}
                            aria-label={language.t("session.header.open.menu")}
                          />
                          <DropdownMenu.Portal>
                            <DropdownMenu.Content class="[&_[data-slot=dropdown-menu-item]]:pl-1 [&_[data-slot=dropdown-menu-radio-item]]:pl-1 [&_[data-slot=dropdown-menu-radio-item]+[data-slot=dropdown-menu-radio-item]]:mt-1">
                              <DropdownMenu.Group>
                                <DropdownMenu.GroupLabel class="!px-1 !py-1">
                                  {language.t("session.header.openIn")}
                                </DropdownMenu.GroupLabel>
                                <DropdownMenu.RadioGroup
                                  class="mt-1"
                                  value={current().id}
                                  onChange={(value) => {
                                    if (!OPEN_APPS.includes(value as OpenApp)) return
                                    selectApp(value as OpenApp)
                                  }}
                                >
                                  <For each={options()}>
                                    {(o) => (
                                      <DropdownMenu.RadioItem
                                        value={o.id}
                                        disabled={opening()}
                                        onSelect={() => {
                                          setMenu("open", false)
                                          openDir(o.id)
                                        }}
                                      >
                                        <div class="flex size-5 shrink-0 items-center justify-center [&_[data-component=app-icon]]:size-5">
                                          <AppIcon id={o.icon} />
                                        </div>
                                        <DropdownMenu.ItemLabel>{o.label}</DropdownMenu.ItemLabel>
                                        <DropdownMenu.ItemIndicator>
                                          <Icon name="check-small" size="small" class="text-icon-weak" />
                                        </DropdownMenu.ItemIndicator>
                                      </DropdownMenu.RadioItem>
                                    )}
                                  </For>
                                </DropdownMenu.RadioGroup>
                              </DropdownMenu.Group>
                              <DropdownMenu.Separator />
                              <DropdownMenu.Item
                                onSelect={() => {
                                  setMenu("open", false)
                                  copyPath()
                                }}
                              >
                                <div class="flex size-5 shrink-0 items-center justify-center">
                                  <Icon name="copy" size="small" class="text-icon-weak" />
                                </div>
                                <DropdownMenu.ItemLabel>
                                  {language.t("session.header.open.copyPath")}
                                </DropdownMenu.ItemLabel>
                              </DropdownMenu.Item>
                            </DropdownMenu.Content>
                          </DropdownMenu.Portal>
                        </DropdownMenu>
                      </div>
                    </div>
                  </Show>
                </div>
              </Show>
              <div class="flex items-center gap-1">
                <Show when={term()}>
                  <TooltipKeybind
                    title={language.t("command.terminal.toggle")}
                    keybind={command.keybind("terminal.toggle")}
                  >
                    <Button
                      variant="ghost"
                      class="group/terminal-toggle titlebar-icon w-8 h-6 p-0 box-border shrink-0"
                      onClick={toggleTerminal}
                      aria-label={language.t("command.terminal.toggle")}
                      aria-expanded={terminalOpen()}
                      aria-controls={view().panel.location("terminal") === "bottom" ? "bottom-panel" : "review-panel"}
                    >
                      <Icon size="small" name={terminalOpen() ? "terminal-active" : "terminal"} />
                    </Button>
                  </TooltipKeybind>
                </Show>
                <TooltipKeybind
                  title={bottomPanelAvailable() ? language.t("command.panel.toggle") : language.t("session.panel.noBottomViews")}
                  keybind={command.keybind("panel.toggle")}
                >
                  <Button
                    variant="ghost"
                    class="group/bottom-panel-toggle titlebar-icon w-8 h-6 p-0 box-border shrink-0"
                    onClick={toggleBottomPanel}
                    aria-label={bottomPanelAvailable() ? language.t("command.panel.toggle") : language.t("session.panel.noBottomViews")}
                    aria-expanded={bottomPanelOpen()}
                    aria-controls="bottom-panel"
                    disabled={!bottomPanelAvailable()}
                  >
                    <Icon size="small" name={bottomPanelOpen() ? "layout-bottom-full" : "layout-bottom"} />
                  </Button>
                </TooltipKeybind>

                <Popover
                  open={panelViewsOpen()}
                  onOpenChange={setPanelViewsOpen}
                  portal
                  class="w-72 rounded-md border border-border-weaker-base bg-background-stronger p-1 shadow-lg"
                  trigger={
                    <span class="group/panel-views titlebar-icon w-8 h-6 p-0 box-border shrink-0 flex items-center justify-center" aria-label={language.t("session.panel.views")}>
                      <Icon size="small" name="menu" />
                    </span>
                  }
                >
                  <div data-panel-views-menu>
                    <div class="px-2 py-1.5 text-12-medium text-text-weak">{language.t("session.panel.views")}</div>
                    <For each={panelViewIDs()}>
                      {(id) => (
                        <div class="mb-1 flex items-center gap-1 rounded-md px-1 py-1 hover:bg-surface-base-hover">
                          <button
                            type="button"
                            class="min-w-0 flex flex-1 items-center gap-2 px-1 text-left text-13-regular text-text-strong"
                            onClick={() => revealPanelView(id)}
                          >
                            <Icon size="small" name={PANEL_VIEW_META[id].icon} />
                            <span class="flex-1 truncate">{language.t(PANEL_VIEW_META[id].titleKey)}</span>
                            <span class="text-11-regular text-text-weak">
                              {language.t(view().panel.location(id) === "bottom" ? "session.panel.location.bottom" : "session.panel.location.side")}
                            </span>
                          </button>
                          <Show when={view().panel.location(id) === "side"}>
                            <IconButton
                              icon="layout-bottom"
                              variant="ghost"
                              iconSize="small"
                              aria-label={`${language.t("session.panel.moveToBottom")}: ${language.t(PANEL_VIEW_META[id].titleKey)}`}
                              title={`${language.t("session.panel.moveToBottom")}: ${language.t(PANEL_VIEW_META[id].titleKey)}`}
                              onClick={() => movePanelView(id, "bottom")}
                            />
                          </Show>
                          <Show when={view().panel.location(id) === "bottom" && view().panel.sideAvailable()}>
                            <IconButton
                              icon="layout-right"
                              variant="ghost"
                              iconSize="small"
                              aria-label={`${language.t("session.panel.moveToSide")}: ${language.t(PANEL_VIEW_META[id].titleKey)}`}
                              title={`${language.t("session.panel.moveToSide")}: ${language.t(PANEL_VIEW_META[id].titleKey)}`}
                              onClick={() => movePanelView(id, "side")}
                            />
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                </Popover>

                <div class="hidden md:flex items-center gap-1 shrink-0">
                  <TooltipKeybind
                    title={language.t("session.sidePanel.toggle")}
                    keybind={command.keybind("sidePanel.toggle")}
                  >
                    <Button
                      variant="ghost"
                      class="group/right-panel-toggle titlebar-icon relative w-8 h-6 p-0 box-border"
                      onClick={toggleRightPanel}
                      aria-label={language.t("session.sidePanel.toggle")}
                      aria-expanded={rightPanelOpen()}
                      aria-controls="review-panel"
                    >
                      <Icon size="small" name={rightPanelOpen() ? "layout-right-full" : "layout-right"} />
                      <Show when={hasRunningSubagent()}>
                        <span
                          class="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-text-success"
                          style={{ animation: "var(--animate-pulse-scale)" }}
                          aria-hidden="true"
                        />
                      </Show>
                    </Button>
                  </TooltipKeybind>
                </div>
                <StatusPopover />
              </div>
            </div>
          </Portal>
        )}
      </Show>
    </>
  )
}
