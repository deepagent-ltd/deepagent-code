import { Show, createSignal } from "solid-js"
import { Button } from "@deepagent-code/ui/button"
import { Icon } from "@deepagent-code/ui/icon"
import { Tooltip } from "@deepagent-code/ui/tooltip"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { armPanel, consultPanel, type PanelGoalClient } from "./panel-goal.api"
import { PanelVerdictDialog } from "./panel-verdict-dialog"

/**
 * V3.9 §C — the Expert Panel toggle button for the composer toolbar.
 *
 * Activation semantics (per the product spec):
 *   - Armed state is per-conversation, seeded from the global `expertPanelDefault` setting.
 *   - OFF → ON (user arms mid-conversation): immediately convene a panel on the CURRENT context and
 *     show the verdict, then go quiet ("等待唤醒") — no per-turn re-runs.
 *   - While ON, pressing again re-convenes on demand.
 *   - ON → OFF: disarm (no consult).
 * The button reflects armed state; a spinner-ish disabled state covers the in-flight consult.
 */
export function PanelButton(props: { sessionID: string }) {
  const sdk = useSDK()
  const settings = useSettings()
  const dialog = useDialog()
  // Seed from the global default; per-conversation toggle overrides it locally + server-side.
  const [armed, setArmed] = createSignal(settings.general.expertPanelDefault())
  const [busy, setBusy] = createSignal(false)

  const client = () => sdk.client as unknown as PanelGoalClient

  const consultNow = async () => {
    const verdict = await consultPanel(client(), { sessionID: props.sessionID })
    if (verdict) dialog.show(() => <PanelVerdictDialog verdict={verdict} />)
  }

  const onClick = async () => {
    if (busy() || !props.sessionID) return
    setBusy(true)
    try {
      if (!armed()) {
        // OFF → ON: arm, then convene once on the current context.
        await armPanel(client(), props.sessionID, true)
        setArmed(true)
        await consultNow()
      } else {
        // Already armed: a press re-convenes on demand (stays armed).
        await consultNow()
      }
    } finally {
      setBusy(false)
    }
  }

  const onDisarm = async (e: MouseEvent) => {
    e.stopPropagation()
    if (busy() || !props.sessionID) return
    setBusy(true)
    try {
      await armPanel(client(), props.sessionID, false)
      setArmed(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Tooltip placement="top" gutter={4} value={armed() ? "Expert panel armed — click to consult now" : "Convene expert panel"}>
      <div class="flex items-center" data-component="prompt-panel-control">
        <Button
          data-action="prompt-panel"
          type="button"
          variant={armed() ? "primary" : "ghost"}
          size="normal"
          class="h-7 px-2 gap-1.5 text-13-regular"
          disabled={busy() || !props.sessionID}
          onClick={onClick}
          aria-pressed={armed()}
          aria-label="Expert panel"
        >
          <Icon name="speech-bubble" class="size-4" />
          <span>Panel</span>
        </Button>
        <Show when={armed()}>
          <Button
            variant="ghost"
            size="small"
            class="size-6 p-0"
            disabled={busy()}
            onClick={onDisarm}
            aria-label="Disarm expert panel"
          >
            <Icon name="close-small" class="size-3.5" />
          </Button>
        </Show>
      </div>
    </Tooltip>
  )
}
