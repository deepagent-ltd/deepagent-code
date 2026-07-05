import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { Tabs } from "@deepagent-code/ui/tabs"
import { ResizeHandle } from "@deepagent-code/ui/resize-handle"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { TooltipKeybind, Tooltip } from "@deepagent-code/ui/tooltip"
import { DragDropProvider, DragDropSensors, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { ConstrainDragYAxis } from "@/utils/solid-dnd"

import { SortableTerminalTab } from "@/components/session"
import { Terminal } from "@/components/terminal"
import { useCommand } from "@/context/command"
import { useDebug } from "@/context/debug"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useTerminal, type PaneLeaf, type PaneNode } from "@/context/terminal"
import { terminalTabLabel } from "@/pages/session/terminal-label"
import { createSizing, focusTerminalById } from "@/pages/session/helpers"
import { getTerminalHandoff, setTerminalHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"

/** Bottom dock can host several kinds of panel; terminal today, debug console next (Phase 4.3). */
type DockTabKind = "terminal" | "debug-console"

/** V3.7 Phase 4.5: Debug Console — renders the shared debug output stream. */
function DebugConsole() {
  const debug = useDebug()
  const language = useLanguage()
  let scroller: HTMLDivElement | undefined
  let atBottom = true

  const categoryColor = (c: string) =>
    c === "stderr" ? "text-red-400" : c === "console" ? "text-blue-400" : "text-text-base"

  // Auto-scroll to bottom on new output unless the user scrolled up.
  createEffect(
    on(
      () => debug.state.output.length,
      () => {
        if (!scroller || !atBottom) return
        queueMicrotask(() => {
          if (scroller) scroller.scrollTop = scroller.scrollHeight
        })
      },
    ),
  )

  const onScroll = () => {
    if (!scroller) return
    atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24
  }

  return (
    <div
      ref={scroller}
      class="absolute inset-0 overflow-y-auto px-3 py-2 font-mono text-12-regular leading-relaxed"
      onScroll={onScroll}
    >
      <Show
        when={debug.state.output.length > 0}
        fallback={
          <div class="h-full flex items-center justify-center text-text-weak text-14-regular">
            {language.t("terminal.debugConsole.placeholder")}
          </div>
        }
      >
        <For each={debug.state.output}>
          {(line) => <div class={`whitespace-pre-wrap break-all ${categoryColor(line.category)}`}>{line.text}</div>}
        </For>
      </Show>
    </div>
  )
}

// ─── Element size tracking (ratio ⇄ px conversion for split resize) ───────────

function createElementSize() {
  const [size, setSize] = createSignal({ width: 0, height: 0 })
  let el: HTMLElement | undefined
  let observer: ResizeObserver | undefined

  const measure = () => {
    if (!el) return
    setSize({ width: el.clientWidth, height: el.clientHeight })
  }

  const ref = (node: HTMLElement) => {
    el = node
    if (typeof ResizeObserver === "undefined") {
      queueMicrotask(measure)
      return
    }
    observer = new ResizeObserver(measure)
    observer.observe(node)
    queueMicrotask(measure)
  }

  onCleanup(() => observer?.disconnect())

  return { ref, size }
}

// ─── Split node ───────────────────────────────────────────────────────────────

function SplitPane(props: { node: Extract<PaneNode, { kind: "split" }> }) {
  const terminal = useTerminal()
  const { ref, size } = createElementSize()

  // dir "horizontal" ⇒ a horizontal divider ⇒ children stacked top/bottom.
  // dir "vertical"   ⇒ a vertical divider   ⇒ children side by side.
  const stacked = () => props.node.dir === "horizontal"
  const total = () => (stacked() ? size().height : size().width)
  const firstPx = () => Math.round(total() * props.node.sizes[0])

  return (
    <div ref={ref} class="flex min-h-0 min-w-0 flex-1" classList={{ "flex-col": stacked(), "flex-row": !stacked() }}>
      <div
        class="relative min-h-0 min-w-0"
        style={{ "flex-basis": `${props.node.sizes[0] * 100}%`, "flex-grow": 0, "flex-shrink": 0 }}
      >
        <PaneRenderer node={props.node.children[0]} />
      </div>
      <ResizeHandle
        direction={stacked() ? "vertical" : "horizontal"}
        edge="end"
        size={firstPx()}
        min={Math.max(60, total() * 0.1)}
        max={Math.max(60, total() * 0.9)}
        onResize={(px) => {
          const t = total()
          if (t <= 0) return
          const ratio = Math.min(0.9, Math.max(0.1, px / t))
          terminal.resizePane(props.node.id, [ratio, 1 - ratio])
        }}
        class="shrink-0"
        classList={{
          // Same token + weight as the panel borders (bottom bar's `border-t
          // border-weak-base`, sidebar's edge): a solid border-weak-base line that
          // reads clearly against the panes' bg-background-stronger. Brightens to
          // border-base on hover for the drag affordance.
          "cursor-col-resize w-px hover:w-0.5 bg-border-weak-base hover:bg-border-base": !stacked(),
          "cursor-row-resize h-px hover:h-0.5 bg-border-weak-base hover:bg-border-base": stacked(),
        }}
      />
      <div class="relative min-h-0 min-w-0 flex-1">
        <PaneRenderer node={props.node.children[1]} />
      </div>
    </div>
  )
}

// ─── Leaf node ──────────────────────────────────────────────────────────────

function LeafPane(props: { node: PaneLeaf }) {
  const terminal = useTerminal()
  const language = useLanguage()
  const { view } = useSessionLayout()
  const [store, setStore] = createStore({
    recovered: {} as Record<string, boolean>,
  })

  const opened = createMemo(() => view().terminal.opened())
  const focused = createMemo(() => terminal.focusedPaneId() === props.node.id)
  const ptys = createMemo(() => {
    const owned = new Set(props.node.ptys)
    // Preserve leaf order, hydrate from the authoritative pty list.
    const byId = new Map(terminal.all().map((p) => [p.id, p] as const))
    return props.node.ptys.flatMap((id) => {
      const p = byId.get(id)
      return p && owned.has(id) ? [p] : []
    })
  })
  const activeId = createMemo(() => props.node.activeId)

  const recoverTerminal = (key: string, id: string, clone: (id: string) => Promise<void>) => {
    if (store.recovered[key]) return
    setStore("recovered", key, true)
    void clone(id)
  }
  const terminalRecoveryKey = (pty: { id: string; title: string; titleNumber: number }) =>
    String(pty.titleNumber || pty.title || pty.id)
  const markTerminalConnected = (key: string, id: string, trim: (id: string) => void) => {
    setStore("recovered", key, false)
    trim(id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return
    const list = ptys()
    const fromIndex = list.findIndex((t) => t.id === draggable.id.toString())
    const toIndex = list.findIndex((t) => t.id === droppable.id.toString())
    if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
      terminal.move(draggable.id.toString(), toIndex)
    }
  }

  const ids = createMemo(() => ptys().map((p) => p.id))

  return (
    <div
      data-terminal-pane={props.node.id}
      data-focused={focused() ? "true" : undefined}
      class="absolute inset-0 flex flex-col overflow-hidden border bg-background-stronger"
      classList={{
        "border-border-base ring-1 ring-inset ring-border-base": focused(),
        "border-border-weak-base": !focused(),
      }}
      onPointerDown={() => terminal.setFocusedPane(props.node.id)}
    >
      <DragDropProvider onDragOver={handleDragOver} collisionDetector={closestCenter}>
        <DragDropSensors />
        <ConstrainDragYAxis />
        <Tabs
          variant="alt"
          value={activeId()}
          onChange={(id) => {
            terminal.setFocusedPane(props.node.id)
            terminal.activateInPane(props.node.id, id)
          }}
          class="!h-auto !flex-none"
        >
          {/* Per-pane header holds only its own tabs. Split/new actions live once
              in the panel dock strip (VSCode-style) and target the focused pane. */}
          <div class="flex items-stretch h-10 border-b border-border-weak-base bg-background-base">
            <Tabs.List class="h-10 min-w-0 flex-1 !border-b-0">
              <SortableProvider ids={ids()}>
                <For each={ptys()}>{(pty) => <SortableTerminalTab terminal={pty} />}</For>
              </SortableProvider>
            </Tabs.List>
          </div>
        </Tabs>
        <div class="flex-1 min-h-0 relative bg-background-stronger">
          <Show
            when={activeId()}
            keyed
            fallback={<div class="absolute inset-0 flex items-center justify-center text-text-weak" />}
          >
            {(id) => {
              const ops = terminal.bind()
              return (
                <Show when={ptys().find((pty) => pty.id === id)}>
                  {(pty) => (
                    <div id={`terminal-wrapper-${id}`} class="absolute inset-0">
                      <Terminal
                        pty={pty()}
                        autoFocus={opened() && focused()}
                        onConnect={() => markTerminalConnected(terminalRecoveryKey(pty()), id, ops.trim)}
                        onCleanup={ops.update}
                        onConnectError={() => recoverTerminal(terminalRecoveryKey(pty()), id, ops.clone)}
                      />
                    </div>
                  )}
                </Show>
              )
            }}
          </Show>
        </div>
      </DragDropProvider>
    </div>
  )
}

function PaneRenderer(props: { node: PaneNode }): ReturnType<typeof LeafPane> {
  return (
    <Show when={props.node.kind === "split" ? (props.node as Extract<PaneNode, { kind: "split" }>) : undefined} keyed
      fallback={<LeafPane node={props.node as PaneLeaf} />}
    >
      {(split) => <SplitPane node={split} />}
    </Show>
  )
}

export function TerminalPanel() {
  const layout = useLayout()
  const terminal = useTerminal()
  const language = useLanguage()
  const command = useCommand()
  const { params, workspaceKey, view } = useSessionLayout()

  const opened = createMemo(() => view().terminal.opened())
  const size = createSizing()
  const height = createMemo(() => layout.terminal.height())
  const close = () => view().terminal.close()
  let root: HTMLDivElement | undefined

  const [store, setStore] = createStore({
    autoCreated: false,
    dock: "terminal" as DockTabKind,
    view: typeof window === "undefined" ? 1000 : (window.visualViewport?.height ?? window.innerHeight),
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

  createEffect(() => {
    if (!opened()) {
      setStore("autoCreated", false)
      return
    }
    if (!terminal.ready() || terminal.all().length !== 0 || store.autoCreated) return
    terminal.new()
    setStore("autoCreated", true)
  })

  createEffect(
    on(
      () => terminal.all().length,
      (count, prevCount) => {
        if (prevCount === undefined || prevCount <= 0 || count !== 0) return
        if (!opened()) return
        close()
      },
    ),
  )

  const focus = (id: string) => {
    focusTerminalById(id)
    const frame = requestAnimationFrame(() => {
      if (!opened()) return
      if (terminal.active() !== id) return
      focusTerminalById(id)
    })
    const timers = [120, 240].map((ms) =>
      window.setTimeout(() => {
        if (!opened()) return
        if (terminal.active() !== id) return
        focusTerminalById(id)
      }, ms),
    )
    return () => {
      cancelAnimationFrame(frame)
      for (const timer of timers) clearTimeout(timer)
    }
  }

  createEffect(
    on(
      () => [opened(), terminal.active(), terminal.focusedPaneId()] as const,
      ([next, id]) => {
        if (!next || !id) return
        if (store.dock !== "terminal") return
        const stop = focus(id)
        onCleanup(stop)
      },
    ),
  )

  createEffect(() => {
    if (opened()) return
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) return
    if (!root?.contains(active)) return
    active.blur()
  })

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

  const dockTabs: { kind: DockTabKind; label: () => string }[] = [
    { kind: "terminal", label: () => language.t("terminal.dock.terminal") },
    { kind: "debug-console", label: () => language.t("terminal.dock.debugConsole") },
  ]

  return (
    <div
      ref={root}
      id="terminal-panel"
      role="region"
      aria-label={language.t("terminal.title")}
      aria-hidden={!opened()}
      inert={!opened()}
      class="relative w-full shrink-0 overflow-hidden bg-background-stronger"
      classList={{
        "border-t border-border-weak-base": opened(),
        "transition-[height] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[height] motion-reduce:transition-none":
          !size.active(),
      }}
      style={{ height: opened() ? `${pane()}px` : "0px" }}
    >
      <div
        class="absolute inset-x-0 top-0 flex flex-col"
        classList={{ "pointer-events-none": !opened() }}
        style={{ height: `${pane()}px` }}
      >
        <div class="hidden md:block" onPointerDown={() => size.start()}>
          <ResizeHandle
            direction="vertical"
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
            {/* Dock strip: tabs on the left, a single set of terminal actions on the
                right (VSCode-style). Split/new act on the focused pane, so they never
                duplicate as panes split. */}
            <div class="flex items-stretch h-8 shrink-0 border-b border-border-weaker-base bg-background-stronger">
              <For each={dockTabs}>
                {(tab) => (
                  <button
                    type="button"
                    class="px-3 h-full text-13-regular border-b-2 -mb-px outline-none"
                    classList={{
                      "border-border-base text-text-stronger": store.dock === tab.kind,
                      "border-transparent text-text-weak hover:text-text": store.dock !== tab.kind,
                    }}
                    onClick={() => setStore("dock", tab.kind)}
                  >
                    {tab.label()}
                  </button>
                )}
              </For>
              <div class="flex-1" />
              <Show when={store.dock === "terminal"}>
                <div class="h-full shrink-0 flex items-center justify-center gap-0.5 px-1">
                  <Tooltip value={language.t("terminal.split")}>
                    <IconButton
                      icon="split-columns"
                      variant="ghost"
                      iconSize="normal"
                      disabled={!terminal.canSplit(terminal.focusedPaneId())}
                      onClick={() => terminal.split("vertical")}
                      aria-label={language.t("terminal.split")}
                    />
                  </Tooltip>
                  <div class="mx-0.5 h-4 w-px shrink-0 bg-border-weaker-base" aria-hidden="true" />
                  <TooltipKeybind
                    title={language.t("command.terminal.new")}
                    keybind={command.keybind("terminal.new")}
                    class="flex items-center"
                  >
                    <IconButton
                      icon="plus-small"
                      variant="ghost"
                      iconSize="large"
                      onClick={() => terminal.new()}
                      aria-label={language.t("command.terminal.new")}
                    />
                  </TooltipKeybind>
                </div>
              </Show>
            </div>
            <div class="flex-1 min-h-0 relative">
              <Show when={store.dock === "terminal"} fallback={<DebugConsole />}>
                <div class="absolute inset-0 flex">
                  <PaneRenderer node={terminal.root()} />
                </div>
              </Show>
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}
