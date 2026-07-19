import { Show } from "solid-js"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { Tooltip } from "@deepagent-code/ui/tooltip"

import { useLanguage } from "@/context/language"
import { type DockPanelID } from "@/context/layout"
import { useTerminal } from "@/context/terminal"
import { useSessionLayout } from "@/pages/session/session-layout"
import { DebugConsole, TerminalActions, TerminalPanes } from "@/pages/session/terminal-view"
import type { JSX } from "solid-js"

/** Shared header strip for a dock panel hosted in the SIDE panel: a title, optional actions, a
 *  "move to bottom dock" button, and the panel's close button. Mirrors the bottom dock's strip so the
 *  two locations feel identical. */
export function SidePanelDockHeader(props: {
  id: DockPanelID
  title: string
  onClose: () => void
  actions?: () => JSX.Element
}) {
  const language = useLanguage()
  const { view } = useSessionLayout()
  const move = () => view().panel.move(props.id, "bottom")
  return (
    <div class="flex h-9 shrink-0 items-center overflow-hidden border-b border-border-weaker-base bg-background-stronger">
      <div class="min-w-0 flex-1 truncate px-3 text-13-regular text-text-stronger">{props.title}</div>
      <div class="flex h-full shrink-0 items-center gap-0.5 whitespace-nowrap px-1">
        <Show when={props.actions}>{(actions) => actions()()}</Show>
        <div class="h-4 w-px shrink-0 bg-border-weaker-base" aria-hidden="true" />
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

/** Terminal hosted in the right side panel. PTY lifecycle is owned by TerminalPanel;
 * this component only provides the side-panel host. */
export function SidePanelTerminal(props: {
  onClose: () => void
}) {
  const language = useLanguage()
  const terminal = useTerminal()
  const { view } = useSessionLayout()
  const terminalReady = () => view().panel.location("terminal") === "side" && terminal.ready()

  return (
    <div class="h-full w-full min-w-0 flex flex-col overflow-hidden bg-background-stronger">
      <SidePanelDockHeader
        id="terminal"
        title={language.t("terminal.dock.terminal")}
        onClose={props.onClose}
        actions={() => <TerminalActions />}
      />
      <div class="relative min-h-0 flex-1" data-terminal-host="side">
        <Show
          when={terminalReady()}
          fallback={<div class="size-full flex items-center justify-center text-13-regular text-text-weak">{language.t("terminal.loading")}</div>}
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
