import { Show, createEffect, createResource, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@deepagent-code/ui/button"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { armPanel, fetchPanelStatus, type PanelGoalClient } from "./panel-goal.api"

/** Retains historical armed state and an explicit disarm action. New consults remain closed. */
export function PanelButton(props: { sessionID: string }) {
  const sdk = useSDK()
  const language = useLanguage()
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  const [state, setState] = createStore<{ busy: boolean; stopped: boolean; error?: string }>({
    busy: false,
    stopped: false,
  })
  const [status] = createResource(
    () => [sdk.client, props.sessionID] as const,
    ([client, sessionID]) =>
      sessionID ? fetchPanelStatus(client as unknown as PanelGoalClient, sessionID).catch(() => undefined) : undefined,
  )
  createEffect(() => {
    sdk.client
    sdk.scope
    sdk.url
    sdk.directory
    props.sessionID
    setState({ busy: false, stopped: false, error: undefined })
  })
  const stop = async () => {
    if (disposed || state.busy || !status()?.armed) return
    const captured = {
      client: sdk.client,
      url: sdk.url,
      scope: sdk.scope,
      directory: sdk.directory,
      sessionID: props.sessionID,
    }
    setState({ busy: true, error: undefined })
    try {
      await armPanel(captured.client as unknown as PanelGoalClient, captured.sessionID, false)
      if (
        disposed ||
        sdk.client !== captured.client ||
        sdk.url !== captured.url ||
        sdk.scope !== captured.scope ||
        sdk.directory !== captured.directory ||
        props.sessionID !== captured.sessionID
      )
        return
      setState("stopped", true)
    } catch (error) {
      if (
        !disposed &&
        sdk.client === captured.client &&
        sdk.scope === captured.scope &&
        props.sessionID === captured.sessionID
      )
        setState("error", error instanceof Error ? error.message : language.t("common.requestFailed"))
    } finally {
      if (
        !disposed &&
        sdk.client === captured.client &&
        sdk.scope === captured.scope &&
        props.sessionID === captured.sessionID
      )
        setState("busy", false)
    }
  }
  return (
    <Show when={status()?.armed || state.stopped}>
      <div data-component="panel-history" class="flex flex-wrap items-center gap-2 text-12-regular text-text-weak">
        <span>{language.t("composer.panel.history")}</span>
        <Show when={status()?.armed && !state.stopped}>
          <Button variant="ghost" size="small" disabled={state.busy} onClick={() => void stop()}>
            {language.t("composer.panel.disarmHistory")}
          </Button>
        </Show>
        <Show when={state.error}>
          <span role="alert">{state.error}</span>
        </Show>
      </div>
    </Show>
  )
}
