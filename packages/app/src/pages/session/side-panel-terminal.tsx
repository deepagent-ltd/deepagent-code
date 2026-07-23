import { Show } from "solid-js"
import { IconButton } from "@deepagent-code/ui/icon-button"

import { useLanguage } from "@/context/language"
import { type DockPanelID } from "@/context/layout"
import { SideTerminalProvider, useTerminal } from "@/context/terminal"
import { DebugConsole, TerminalActions, TerminalPanes, useTerminalLifecycle } from "@/pages/session/terminal-view"
import type { JSX } from "solid-js"

// ---------------------------------------------------------------------------
// SidePanelTerminal — side-native terminal host.
// Independent from the bottom dock. Move-to-bottom / move-to-side buttons are
// intentionally removed per Phase 3 design (§5.5).
// ---------------------------------------------------------------------------

function SidePanelTerminalContent(props: { onClose: () => void }) {
  const language = useLanguage()
  const terminal = useTerminal()

  // Lifecycle: auto-create first PTY when side panel opens; close panel when empty.
  useTerminalLifecycle({
    active: () => true,
    close: props.onClose,
    rootEl: () => document.querySelector<HTMLElement>('[data-terminal-host="side"]') ?? undefined,
  })

  return (
    <div class="h-full w-full min-w-0 flex flex-col overflow-hidden bg-background-stronger">
      {/* Simple header — no move button */}
      <div class="flex h-9 shrink-0 items-center overflow-hidden border-b border-border-weaker-base bg-background-stronger">
        <div class="min-w-0 flex-1 truncate px-3 text-13-regular text-text-stronger">
          {language.t("terminal.dock.terminal")}
        </div>
        <div class="flex h-full shrink-0 items-center gap-0.5 whitespace-nowrap px-1">
          <TerminalActions />
          <div class="h-4 w-px shrink-0 bg-border-weaker-base" aria-hidden="true" />
          <IconButton
            icon="close-small"
            variant="ghost"
            iconSize="normal"
            onClick={props.onClose}
            aria-label={language.t("common.close")}
          />
        </div>
      </div>
      <div class="relative min-h-0 flex-1" data-terminal-host="side">
        <Show
          when={terminal.ready()}
          fallback={
            <div class="size-full flex items-center justify-center text-13-regular text-text-weak">
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

/** Side-panel terminal host. Wraps in SideTerminalProvider so all terminal-view
 *  components target the side session independently of the bottom dock. */
export function SidePanelTerminal(props: { onClose: () => void }) {
  return (
    <SideTerminalProvider>
      <SidePanelTerminalContent onClose={props.onClose} />
    </SideTerminalProvider>
  )
}

// ---------------------------------------------------------------------------
// SidePanelDebugConsole — unchanged, debug console is not dual-host.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// SidePanelDockHeader — retained for non-terminal dock panels (debug-console,
// problems) that session-side-panel.tsx uses directly.
// "Move to bottom" button removed per Phase 3 §5.5.
// ---------------------------------------------------------------------------

/** Shared header strip for a dock panel hosted in the SIDE panel.
 *  "Move to bottom" button has been removed — bottom and side are now independent. */
export function SidePanelDockHeader(props: {
  id: DockPanelID
  title: string
  onClose: () => void
  actions?: () => JSX.Element
}) {
  const language = useLanguage()
  return (
    <div class="flex h-9 shrink-0 items-center overflow-hidden border-b border-border-weaker-base bg-background-stronger">
      <div class="min-w-0 flex-1 truncate px-3 text-13-regular text-text-stronger">{props.title}</div>
      <div class="flex h-full shrink-0 items-center gap-0.5 whitespace-nowrap px-1">
        <Show when={props.actions}>{(actions) => actions()()}</Show>
        <div class="h-4 w-px shrink-0 bg-border-weaker-base" aria-hidden="true" />
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

