import { createSignal, createResource } from "solid-js"
import { Button } from "@deepagent-code/ui/button"
import { Icon } from "@deepagent-code/ui/icon"
import { MenuV2 } from "@deepagent-code/ui/v2/menu-v2"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { armPanel, consultPanel, fetchPanelStatus, type PanelGoalClient, type PanelRounds } from "./panel-goal.api"
import { PanelVerdictDialog } from "./panel-verdict-dialog"

/**
 * V4.0 §C — the Expert Panel control for the composer toolbar, as a THREE-STATE menu.
 *
 * Clicking the button opens a menu with three mutually-exclusive choices (replaces the old
 * Shift/Alt-click "deep convene" gesture with an explicit, discoverable control):
 *   - Off            → disarm; icon NOT lit (ghost). No convene.
 *   - Single-round   → arm + convene ONE round now; icon lit (primary).
 *   - Multi-round    → arm + convene up to 3 anonymized debate rounds now (§C.4); icon lit (primary).
 * Both Single and Multi light the icon (armed); only Off is unlit. The chosen depth PERSISTS per
 * session (server-side), so re-convening later reuses it. Arm state seeds from the server's effective
 * status (explicit toggle, else global `expertPanelDefault`).
 */
export function PanelButton(props: { sessionID: string }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const language = useLanguage()
  const [busy, setBusy] = createSignal(false)
  const [armedOverride, setArmedOverride] = createSignal<boolean | undefined>(undefined)
  const [roundsOverride, setRoundsOverride] = createSignal<PanelRounds | undefined>(undefined)

  const client = () => sdk.client as unknown as PanelGoalClient

  const [status] = createResource(
    () => props.sessionID || undefined,
    (sessionID) => fetchPanelStatus(client(), sessionID),
  )
  const armed = () => armedOverride() ?? status()?.armed ?? false
  const rounds = (): PanelRounds => roundsOverride() ?? status()?.rounds ?? "single"

  // The server clamps the ceiling; multi requests 3 debate rounds, single requests 1.
  const DEEP_PANEL_ROUNDS = 3
  const consultNow = async (depth: PanelRounds) => {
    const verdict = await consultPanel(client(), {
      sessionID: props.sessionID,
      ...(depth === "multi" ? { maxRounds: DEEP_PANEL_ROUNDS } : {}),
    })
    if (verdict) dialog.show(() => <PanelVerdictDialog verdict={verdict} />)
  }

  // Off: disarm, no consult. Single/Multi: arm + persist the depth + convene once at that depth.
  const choose = async (choice: "off" | PanelRounds) => {
    if (busy() || !props.sessionID) return
    setBusy(true)
    try {
      if (choice === "off") {
        await armPanel(client(), props.sessionID, false)
        setArmedOverride(false)
        return
      }
      await armPanel(client(), props.sessionID, true, choice)
      setArmedOverride(true)
      setRoundsOverride(choice)
      await consultNow(choice)
    } finally {
      setBusy(false)
    }
  }

  const activeKey = (): "off" | PanelRounds => (!armed() ? "off" : rounds())

  return (
    <MenuV2 gutter={4} modal={false} placement="top-start">
      <MenuV2.Trigger
        as={Button}
        data-action="prompt-panel"
        type="button"
        variant={armed() ? "primary" : "ghost"}
        size="normal"
        class="h-7 px-2 gap-1.5 text-13-regular"
        disabled={busy() || !props.sessionID}
        aria-pressed={armed()}
        aria-label={language.t("composer.panel.label")}
      >
        <Icon name="experts" class="size-4" />
        <span>{language.t("composer.panel.label")}</span>
      </MenuV2.Trigger>
      <MenuV2.Portal>
        <MenuV2.Content data-component="prompt-panel-menu">
          <MenuV2.Group>
            <MenuV2.GroupLabel>{language.t("composer.panel.label")}</MenuV2.GroupLabel>
            <MenuV2.Item
              data-action="prompt-panel-off"
              onSelect={() => void choose("off")}
              badge={activeKey() === "off" ? <Icon name="check" class="size-3.5" /> : undefined}
            >
              {language.t("composer.panel.off")}
            </MenuV2.Item>
            <MenuV2.Item
              data-action="prompt-panel-single"
              onSelect={() => void choose("single")}
              badge={activeKey() === "single" ? <Icon name="check" class="size-3.5" /> : undefined}
            >
              {language.t("composer.panel.single")}
            </MenuV2.Item>
            <MenuV2.Item
              data-action="prompt-panel-multi"
              onSelect={() => void choose("multi")}
              badge={activeKey() === "multi" ? <Icon name="check" class="size-3.5" /> : undefined}
            >
              {language.t("composer.panel.multi")}
            </MenuV2.Item>
          </MenuV2.Group>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}
