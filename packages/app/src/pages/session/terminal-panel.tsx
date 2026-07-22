import { For, Show, Switch, Match, createEffect, createMemo, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { ResizeHandle } from "@deepagent-code/ui/resize-handle"
import { Icon } from "@deepagent-code/ui/icon"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { Tooltip } from "@deepagent-code/ui/tooltip"
import { useLanguage } from "@/context/language"
import { useLayout, type DockPanelID } from "@/context/layout"
import { BottomTerminalProvider, useTerminal } from "@/context/terminal"
import { terminalTabLabel } from "@/pages/session/terminal-label"
import { createSizing } from "@/pages/session/helpers"
import { setTerminalHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import { DebugConsole, TerminalActions, TerminalPanes, useTerminalLifecycle } from "@/pages/session/terminal-view"
import { ProblemsPanel } from "@/pages/session/problems-panel"
import { PANEL_VIEW_META } from "@/pages/session/panel-view-registry"

const PANEL_META = PANEL_VIEW_META

type Props = {
  onOpenFile: (path: string, line: number) => void
}

/** Inner content rendered under BottomTerminalProvider context. */
function TerminalPanelContent(props: Props) {
  const layout = useLayout()
  const terminal = useTerminal()
  const language = useLanguage()
  const { params, workspaceKey, view } = useSessionLayout()
  const size = createSizing()
  const height = createMemo(() => layout.terminal.height())
  const panel = () => view().panel
  const opened = createMemo(() => panel().bottom.opened())
  const active = createMemo(() => panel().bottom.activeView())
  // Bottom panel only shows the non-terminal dock panels (debug-console, problems).
  // Terminal is no longer a movable dock view — it is bottom-native here.
  const bottomTabs = createMemo<DockPanelID[]>(() => panel().viewsAt("bottom"))
  const visible = createMemo(() => opened())
  const [store, setStore] = createStore({
    view: typeof window === "undefined" ? 1000 : (window.visualViewport?.height ?? window.innerHeight),
  })
  let root: HTMLDivElement | undefined

  const max = () => store.view * 0.6
  const pane = () => Math.min(height(), max())
  const close = () => panel().bottom.toggle()

  // Bottom terminal is visible when the bottom panel is open with terminal as active view.
  const terminalVisible = createMemo(() =>
    panel().bottom.opened() && panel().bottom.activeView() === "terminal",
  )

  // Lifecycle owner for the bottom host — auto-creates, auto-focuses, closes panel when empty.
  useTerminalLifecycle({
    active: terminalVisible,
    close: () => panel().toggle("terminal"),
    rootEl: () => document.querySelector<HTMLElement>('[data-terminal-host="bottom"]') ?? root,
  })

  onMount(() => {
    if (typeof window === "undefined") return
    const sync = () => setStore("view", window.visualViewport?.height ?? window.innerHeight)
    sync()
    makeEventListener(window, "resize", sync)
    if (window.visualViewport) makeEventListener(window.visualViewport, "resize", sync)
  })

  createEffect(() => {
    if (!params.dir || !terminal.ready()) return
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

  return (
    <div
      ref={root}
      id="bottom-panel"
      role="region"
      aria-label={language.t("session.panel.bottom")}
      aria-hidden={!visible()}
      inert={!visible()}
      class="relative w-full shrink-0 overflow-hidden bg-background-stronger"
      classList={{
        "transition-[height] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[height] motion-reduce:transition-none":
          !size.active(),
      }}
      style={{ height: visible() ? `${pane()}px` : "0px" }}
    >
      <div
        class="absolute inset-x-0 top-0 flex flex-col"
        classList={{ "pointer-events-none": !visible() }}
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
        <div class="flex flex-col h-full">
          <div class="flex h-9 shrink-0 items-center overflow-hidden border-b border-border-weaker-base bg-background-stronger">
            <div
              class="flex min-w-0 flex-1 h-full overflow-x-auto"
              role="tablist"
              aria-label={language.t("session.panel.bottom")}
            >
              <For each={bottomTabs()}>
                {(id) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active() === id}
                    class="px-3 h-full shrink-0 flex items-center gap-1.5 text-13-regular border-b-2 -mb-px outline-none"
                    classList={{
                      "border-border-base text-text-stronger": active() === id,
                      "border-transparent text-text-weak hover:text-text": active() !== id,
                    }}
                    onClick={() => panel().reveal(id)}
                  >
                    <Icon name={PANEL_META[id].icon} size="small" />
                    {language.t(PANEL_META[id].titleKey)}
                  </button>
                )}
              </For>
            </div>
            <div class="flex h-full shrink-0 items-center gap-0.5 whitespace-nowrap px-1">
              <Show when={active() === "terminal"}>
                <TerminalActions />
              </Show>
              <Show when={active() === "terminal"}>
                <div class="h-4 w-px shrink-0 bg-border-weaker-base" aria-hidden="true" />
              </Show>
              {/* "Move to side" button removed — bottom and side are now independent hosts. */}
              <Tooltip value={language.t("common.close")}>
                <IconButton
                  icon="close"
                  variant="ghost"
                  iconSize="normal"
                  aria-label={language.t("common.close")}
                  onClick={close}
                />
              </Tooltip>
            </div>
          </div>
          <div class="relative min-h-0 flex-1">
            <Show
              when={active()}
              fallback={
                <div class="size-full flex items-center justify-center text-13-regular text-text-weak">
                  <div>{language.t("session.panel.emptyBottom")}</div>
                </div>
              }
            >
              {(id) => (
                <Switch>
                  <Match when={id() === "terminal"}>
                    <Show
                      when={terminal.ready()}
                      fallback={
                        <div class="size-full flex items-center justify-center text-13-regular text-text-weak">
                          {language.t("terminal.loading")}
                        </div>
                      }
                    >
                      <div class="size-full relative" data-terminal-host="bottom">
                        <TerminalPanes />
                      </div>
                    </Show>
                  </Match>
                  <Match when={id() === "debug-console"}>
                    <DebugConsole />
                  </Match>
                  <Match when={id() === "problems"}>
                    <ProblemsPanel active={() => visible() && active() === "problems"} onOpenFile={props.onOpenFile} />
                  </Match>
                </Switch>
              )}
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Bottom-dock terminal panel. Provides the BottomTerminalProvider context so all
 *  terminal-view components (TerminalPanes, TerminalActions, …) target the bottom session. */
export function TerminalPanel(props: Props) {
  return (
    <BottomTerminalProvider>
      <TerminalPanelContent {...props} />
    </BottomTerminalProvider>
  )
}
