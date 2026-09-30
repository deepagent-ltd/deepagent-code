import { Show, Switch, Match, createEffect, createMemo, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { ResizeHandle } from "@deepagent-code/ui/resize-handle"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { Tooltip } from "@deepagent-code/ui/tooltip"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { BottomTerminalProvider, useTerminal } from "@/context/terminal"
import { terminalTabLabel } from "@/pages/session/terminal-label"
import { createSizing } from "@/pages/session/helpers"
import { setTerminalHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import { DebugConsole, TerminalActions, TerminalPanes, useTerminalLifecycle } from "@/pages/session/terminal-view"
import { ProblemsPanel } from "@/pages/session/problems-panel"

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
  const single = createMemo(() => terminal.root()?.kind === "leaf")
  // Bottom panel only shows the non-terminal dock panels (debug-console, problems).
  // Terminal is no longer a movable dock view — it is bottom-native here.
  const visible = createMemo(() => opened())
  const [store, setStore] = createStore({
    view: typeof window === "undefined" ? 1000 : (window.visualViewport?.height ?? window.innerHeight),
  })
  let root: HTMLDivElement | undefined

  const max = () => store.view * 0.6
  const pane = () => Math.min(height(), max())
  const close = () => panel().bottom.toggle()

  // Bottom terminal is visible when the bottom panel is open with terminal as active view.
  const terminalVisible = createMemo(() => panel().bottom.opened() && panel().bottom.activeView() === "terminal")

  // Lifecycle owner for the bottom host — auto-creates, auto-focuses, closes panel when empty.
  // Gate `active` on runtimeId being set to prevent pty.create firing before the server
  // instance is ready (cold-start with persisted opened=true produces immediate 503 failures).
  useTerminalLifecycle({
    active: () => terminalVisible() && (terminal.runtimeId() !== undefined || terminal.all().length > 0),
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

  const actions = () => (
    <div class="flex h-full shrink-0 items-center gap-0.5 whitespace-nowrap px-1">
      <Show when={active() === "terminal"}>
        <TerminalActions />
      </Show>
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
  )

  return (
    <div
      ref={root}
      id="bottom-panel"
      role="region"
      aria-label={language.t("session.panel.bottom")}
      aria-hidden={!visible()}
      inert={!visible()}
      class="relative w-full shrink-0 overflow-hidden"
      classList={{
        // Suppress height animation until layout persisted state has loaded.
        // Without this guard the panel snaps from 0→pane() height on cold start
        // when the persisted `opened:true` arrives after the in-memory default.
        "transition-[height] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[height] motion-reduce:transition-none":
          !size.active() && layout.ready(),
      }}
      style={{ height: visible() ? `calc(${pane()}px + var(--workbench-gap))` : "0px" }}
    >
      <div
        class="absolute inset-x-0 top-0 flex flex-col"
        classList={{ "pointer-events-none": !visible() }}
        style={{ height: `calc(${pane()}px + var(--workbench-gap))` }}
      >
        <div class="hidden md:block" onPointerDown={() => size.start()}>
          <ResizeHandle
            direction="vertical"
            style={{ top: "calc(var(--workbench-gap) / 2)" }}
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
        <div class="workbench-panel flex flex-col flex-1 min-h-0 mt-[var(--workbench-gap)]">
          <Show when={active() !== "terminal" || !single()}>
            <div class="flex h-9 shrink-0 items-center pl-1.5 pr-1">
              <div class="flex min-w-0 flex-1 h-full items-center pl-3">
                <span class="text-12-regular text-text-weak select-none">{language.t("session.panel.bottom")}</span>
              </div>
              {actions()}
            </div>
          </Show>
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
                        <TerminalPanes actions={single() ? actions() : undefined} />
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
