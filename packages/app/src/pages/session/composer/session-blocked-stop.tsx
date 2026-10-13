import { onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@deepagent-code/ui/button"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { errorMessage } from "@/pages/layout/helpers"
import { ScopedKey } from "@/utils/server-scope"
import { resetScenarioOnStop } from "@/components/prompt-input/scenario-override"

// Permission and question docks hide PromptInput, so its stop control cannot be reached.
export function SessionBlockedStop(props: { sessionID: string; onAbort?: () => void }) {
  const sdk = useSDK()
  const language = useLanguage()
  const [store, setStore] = createStore({ active: true, stopping: false })
  onCleanup(() => setStore("active", false))

  const stop = () => {
    if (!store.active || store.stopping) return
    const source = { sessionID: props.sessionID, client: sdk.client, directory: sdk.directory, scope: sdk.scope }
    const current = () =>
      store.active &&
      props.sessionID === source.sessionID &&
      sdk.client === source.client &&
      sdk.directory === source.directory &&
      sdk.scope === source.scope
    setStore("stopping", true)
    resetScenarioOnStop(ScopedKey.from(source.scope, source.sessionID), ScopedKey.from(source.scope, source.directory))
    props.onAbort?.()
    void source.client.session
      .abort({ sessionID: source.sessionID }, { throwOnError: true })
      .catch((error: unknown) => {
        if (!current()) return
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(error, language.t("common.requestFailed")),
        })
      })
      .finally(() => {
        if (!store.active) return
        setStore("stopping", false)
      })
  }

  return (
    <div class="flex justify-end pt-2">
      <Button variant="secondary" size="normal" icon="stop" disabled={store.stopping} onClick={stop}>
        {language.t("prompt.action.stop")}
      </Button>
    </div>
  )
}
