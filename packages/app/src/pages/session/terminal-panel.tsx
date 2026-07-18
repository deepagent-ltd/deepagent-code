import { For, Show, createEffect, createMemo, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { ResizeHandle } from "@deepagent-code/ui/resize-handle"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { Tooltip } from "@deepagent-code/ui/tooltip"

import { useLanguage } from "@/context/language"
import { useLayout, type DockPanelID } from "@/context/layout"
import { useTerminal } from "@/context/terminal"
import { terminalTabLabel } from "@/pages/session/terminal-label"
import { createSizing } from "@/pages/session/helpers"
import { getTerminalHandoff, setTerminalHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import { DebugConsole, TerminalActions, TerminalPanes, useTerminalLifecycle } from "@/pages/session/terminal-view"

/** Bottom dock can host the two movable panels: terminal + debug console. */
type DockTabKind = DockPanelID

export function TerminalPanel() {
  const layout = useLayout()
  const terminal = useTerminal()
  const language = useLanguage()
  const { params, workspaceKey, view } = useSessionLayout()

  const opened = createMemo(() => view().terminal.opened())
  const size = createSizing()
  const height = createMemo(() => layout.terminal.height())
  const close = () => view().terminal.close()
  let root: HTMLDivElement | undefined

  // Which movable panels currently live in the bottom dock (location = "bottom").
  const bottomTabs = createMemo<DockTabKind[]>(() =>
    (["terminal", "debug-console"] as const).filter((id) => layout.dock.location(id) === "bottom"),
  )
  // The dock renders only when it's toggled open AND at least one panel lives here.
  const dockVisible = createMemo(() => opened() && bottomTabs().length > 0)

  const [store, setStore] = createStore({
    dock: "terminal" as DockTabKind,
    view: typeof window === "undefined" ? 1000 : (window.visualViewport?.height ?? window.innerHeight),
  })

  // Keep the active tab valid: if the active panel was moved to the side (or is otherwise absent),
  // fall back to the first panel still in the bottom dock.
  createEffect(() => {
    const tabs = bottomTabs()
    if (tabs.length === 0) return
    if (!tabs.includes(store.dock)) setStore("dock", tabs[0])
  })

  const max = () => store.view * 0.6
  const pane = () => Math.min(height(), max())

  onMount(() => {
    if (typeof window === "undefined") return
    const sync = () => setStore("view", window.visualViewport?.height ?? window.innerHeight)
    const port = window.visualViewport
    sync()
    makeEventListener(window, "resize", sync)
    if (port) makeEventListener(port, "resize", sync)
  })

  // Terminal lifecycle applies while the terminal tab is the shown one in the bottom dock.
  const terminalShown = createMemo(() => dockVisible() && store.dock === "terminal")
  useTerminalLifecycle({ active: terminalShown, close, rootEl: () => root })

  createEffect(() => {
    const dir = params.dir
    if (!dir) return
    if (!terminal.ready()) return
    language.locale()
    setTerminalHandoff(
      workspaceKey(),
      terminal.all().map((pty) =>
        terminalTabLabel({
          title: pty.title,
          titleNumber: pty.titleNumber,
          t: language.t as (key: string, vars?: Record<string, string | number | boolean>) => string,
        }),
      ),
    )
  })

  const handoff = createMemo(() => {
    const dir = params.dir
    if (!dir) return []
    return getTerminalHandoff(workspaceKey()) ?? []
  })

  const dockLabel = (kind: DockTabKind) =>
    kind === "terminal" ? language.t("terminal.dock.terminal") : language.t("terminal.dock.debugConsole")

  return (
    <div
      ref={root}
      id="terminal-panel"
      role="region"
      aria-label={language.t("terminal.title")}
      aria-hidden={!dockVisible()}
      inert={!dockVisible()}
      class="relative w-full shrink-0 overflow-hidden bg-background-stronger"
      classList={{
        // No static `border-t` here: the dock's ResizeHandle draws the single, always-visible
        // VSCode-style divider (see resize-handle--dock). A border here would sit right on top of
        // the drag bar and compete with it, which is exactly the ambiguity we're removing.
        "transition-[height] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[height] motion-reduce:transition-none":
          !size.active(),
      }}
      style={{ height: dockVisible() ? `${pane()}px` : "0px" }}
    >
      <div
        class="absolute inset-x-0 top-0 flex flex-col"
        classList={{ "pointer-events-none": !dockVisible() }}
        style={{ height: `${pane()}px` }}
      >
        <div class="hidden md:block" onPointerDown={() => size.start()}>
          <ResizeHandle
            direction="vertical"
            class="resize-handle--dock"
            size={pane()}
            min={100}
            max={max()}
            collapseThreshold={50}
            onResize={(next) => {
              size.touch()
              layout.terminal.resize(next)
            }}
            onCollapse={close}
          />
        </div>
        <Show
          when={terminal.ready()}
          fallback={
            <div class="flex flex-col h-full pointer-events-none">
              <div class="h-10 flex items-center gap-2 px-2 border-b border-border-weaker-base bg-background-stronger overflow-hidden">
                <For each={handoff()}>
                  {(title) => (
                    <div class="px-2 py-1 rounded-md bg-surface-base text-14-regular text-text-weak truncate max-w-40">
                      {title}
                    </div>
                  )}
                </For>
                <div class="flex-1" />
                <div class="text-text-weak pr-2">
                  {language.t("common.loading")}
                  {language.t("common.loading.ellipsis")}
                </div>
              </div>
              <div class="flex-1 flex items-center justify-center text-text-weak">{language.t("terminal.loading")}</div>
            </div>
          }
        >
          <div class="flex flex-col h-full">
            {/* Dock strip: tabs on the left, terminal actions + a "move to side panel" button on the
                right. Only tabs whose panel lives in the bottom dock are shown; moving the last one to
                the side collapses the dock. */}
            <div class="flex items-stretch h-8 shrink-0 border-b border-border-weaker-base bg-background-stronger">
              <For each={bottomTabs()}>
                {(tab) => (
                  <button
                    type="button"
                    class="px-3 h-full text-13-regular border-b-2 -mb-px outline-none"
                    classList={{
                      "border-border-base text-text-stronger": store.dock === tab,
                      "border-transparent text-text-weak hover:text-text": store.dock !== tab,
                    }}
                    onClick={() => setStore("dock", tab)}
                  >
                    {dockLabel(tab)}
                  </button>
                )}
              </For>
              <div class="flex-1" />
              <Show when={store.dock === "terminal"}>
                <TerminalActions />
              </Show>
              <div class="h-full shrink-0 flex items-center justify-center px-1">
                <Tooltip value={language.t("dock.moveToSide")}>
                  <IconButton
                    icon="layout-right"
                    variant="ghost"
                    iconSize="normal"
                    onClick={() => layout.dock.setLocation(store.dock, "side")}
                    aria-label={language.t("dock.moveToSide")}
                  />
                </Tooltip>
              </div>
            </div>
            <div class="flex-1 min-h-0 relative">
              <Show when={store.dock === "terminal"} fallback={<DebugConsole />}>
                <TerminalPanes />
              </Show>
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}
