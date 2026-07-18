import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
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
import { useTerminal, type PaneLeaf, type PaneNode } from "@/context/terminal"
import { useSessionLayout } from "@/pages/session/session-layout"
import { focusTerminalById } from "@/pages/session/helpers"

// ─── Debug console (shared: bottom dock + side panel) ───────────────────────────

/** V3.7 Phase 4.5: Debug Console — renders the shared debug output stream. */
export function DebugConsole() {
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

// ─── Split node ─────────────────────────────────────────────────────────────

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

// ─── Leaf node ────────────────────────────────────────────────────────────────

function LeafPane(props: { node: PaneLeaf }) {
  const terminal = useTerminal()
  const { view } = useSessionLayout()
  const [store, setStore] = createStore({
    recovered: {} as Record<string, boolean>,
  })

  const opened = createMemo(() => view().terminal.opened())
  const focused = createMemo(() => terminal.focusedPaneId() === props.node.id)
  const ptys = createMemo(() => {
    const owned = new Set(props.node.ptys)
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
    <Show
      when={props.node.kind === "split" ? (props.node as Extract<PaneNode, { kind: "split" }>) : undefined}
      keyed
      fallback={<LeafPane node={props.node as PaneLeaf} />}
    >
      {(split) => <SplitPane node={split} />}
    </Show>
  )
}

// ─── Shared terminal actions (split / new) ──────────────────────────────────────

/** The split + new-terminal action cluster shared by the bottom dock strip and the side panel
 *  header. Acts on the focused pane, so it never duplicates as panes split (VSCode-style). */
export function TerminalActions() {
  const terminal = useTerminal()
  const language = useLanguage()
  const command = useCommand()
  return (
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
  )
}

/** The terminal pane tree (splits + leaves + tabs). Position-agnostic: mounted by both the
 *  bottom dock and the side panel. PTY state is workspace-scoped, so both mounts share one store —
 *  but at any time a panel lives in only one location, so there is never a double mount. */
export function TerminalPanes() {
  const terminal = useTerminal()
  return (
    <div class="absolute inset-0 flex">
      <PaneRenderer node={terminal.root()} />
    </div>
  )
}

// ─── Shared terminal lifecycle ──────────────────────────────────────────────────

/** Auto-create-on-open, focus-follows-active, blur-on-hide, and close-on-empty — the effects that
 *  make a terminal surface behave, regardless of WHERE it's docked. `active()` = "the terminal is
 *  currently shown in this location"; `close()` = hide this location (close the bottom dock / close
 *  the side panel). Since a panel lives in exactly one location at a time, only one caller's
 *  `active()` is ever true, so there's no double auto-create or double close. */
export function useTerminalLifecycle(opts: {
  active: () => boolean
  close: () => void
  rootEl: () => HTMLElement | undefined
}) {
  const terminal = useTerminal()
  const [autoCreated, setAutoCreated] = createSignal(false)

  createEffect(() => {
    if (!opts.active()) {
      setAutoCreated(false)
      return
    }
    if (!terminal.ready() || terminal.all().length !== 0 || autoCreated()) return
    terminal.new()
    setAutoCreated(true)
  })

  createEffect(
    on(
      () => terminal.all().length,
      (count, prevCount) => {
        if (prevCount === undefined || prevCount <= 0 || count !== 0) return
        if (!opts.active()) return
        opts.close()
      },
    ),
  )

  const focus = (id: string) => {
    focusTerminalById(id)
    const frame = requestAnimationFrame(() => {
      if (!opts.active()) return
      if (terminal.active() !== id) return
      focusTerminalById(id)
    })
    const timers = [120, 240].map((ms) =>
      window.setTimeout(() => {
        if (!opts.active()) return
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
      () => [opts.active(), terminal.active(), terminal.focusedPaneId()] as const,
      ([next, id]) => {
        if (!next || !id) return
        const stop = focus(id)
        onCleanup(stop)
      },
    ),
  )

  createEffect(() => {
    if (opts.active()) return
    const el = document.activeElement
    if (!(el instanceof HTMLElement)) return
    if (!opts.rootEl()?.contains(el)) return
    el.blur()
  })
}

