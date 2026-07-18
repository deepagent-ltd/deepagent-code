import { Show, createMemo } from "solid-js"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { Tooltip } from "@deepagent-code/ui/tooltip"

import { useLanguage } from "@/context/language"
import { useLayout, type DockPanelID } from "@/context/layout"
import { useTerminal } from "@/context/terminal"
import { useSessionLayout } from "@/pages/session/session-layout"
import { DebugConsole, TerminalActions, TerminalPanes, useTerminalLifecycle } from "@/pages/session/terminal-view"
import type { JSX } from "solid-js"

/** Shared header strip for a dock panel hosted in the SIDE panel: a title, optional actions, a
 *  "move to bottom dock" button, and the panel's close button. Mirrors the bottom dock's strip so the
 *  two locations feel identical. */
function SidePanelDockHeader(props: {
  id: DockPanelID
  title: string
  onClose: () => void
  actions?: () => JSX.Element
}) {
  const language = useLanguage()
  const layout = useLayout()
  const move = () => layout.dock.setLocation(props.id, "bottom")
  return (
    <div class="flex items-stretch h-8 shrink-0 border-b border-border-weaker-base bg-background-stronger">
      <div class="flex items-center px-3 text-13-regular text-text-stronger">{props.title}</div>
      <div class="flex-1" />
      <Show when={props.actions}>{(a) => a()()}</Show>
      <div class="h-full shrink-0 flex items-center justify-center px-1">
        <Tooltip value={language.t("dock.moveToBottom")}>
          <IconButton
            icon="layout-bottom"
            variant="ghost"
            iconSize="normal"
            onClick={move}
            aria-label={language.t("dock.moveToBottom")}
          />
        </Tooltip>
        <IconButton
          icon="close-small"
          variant="ghost"
          iconSize="normal"
          onClick={props.onClose}
          aria-label={language.t("common.close")}
        />
      </div>
    </div>
  )
}

/** Terminal hosted in the right side panel. Reuses the exact same pane tree + actions + lifecycle as
 *  the bottom dock — only the mount point differs. */
export function SidePanelTerminal(props: { onClose: () => void }) {
  const language = useLanguage()
  const terminal = useTerminal()
  const { view } = useSessionLayout()
  let root: HTMLDivElement | undefined

  // Active whenever the side panel is showing the terminal (this component only mounts then).
  const active = createMemo(() => view().rightPanel.mode() === "terminal")
  useTerminalLifecycle({ active, close: props.onClose, rootEl: () => root })

  return (
    <div ref={root} class="h-full w-full min-w-0 flex flex-col overflow-hidden bg-background-stronger">
      <SidePanelDockHeader
        id="terminal"
        title={language.t("terminal.dock.terminal")}
        onClose={props.onClose}
        actions={() => <TerminalActions />}
      />
      <div class="flex-1 min-h-0 relative">
        <Show
          when={terminal.ready()}
          fallback={
            <div class="absolute inset-0 flex items-center justify-center text-text-weak">
              {language.t("terminal.loading")}
            </div>
          }
        >
          <TerminalPanes />
        </Show>
      </div>
    </div>
  )
}

/** Debug console hosted in the right side panel. */
export function SidePanelDebugConsole(props: { onClose: () => void }) {
  const language = useLanguage()
  return (
    <div class="h-full w-full min-w-0 flex flex-col overflow-hidden bg-background-stronger">
      <SidePanelDockHeader id="debug-console" title={language.t("terminal.dock.debugConsole")} onClose={props.onClose} />
      <div class="flex-1 min-h-0 relative">
        <DebugConsole />
      </div>
    </div>
  )
}
