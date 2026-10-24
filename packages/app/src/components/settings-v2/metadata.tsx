import { onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@deepagent-code/ui/v2/button-v2"
import { useLanguage } from "@/context/language"

/** Complete read-only values remain available when clipboard access is unavailable. */
export function SettingsMetadata(props: { title: string; value: string }) {
  const language = useLanguage()
  const [state, setState] = createStore({ busy: false, result: "" as "" | "copied" | "failed" })
  const owner = { current: true }
  onCleanup(() => (owner.current = false))
  const copy = async () => {
    if (state.busy) return
    const value = props.value
    setState({ busy: true, result: "" })
    const copied = await navigator.clipboard?.writeText(value).then(
      () => true,
      () => false,
    )
    if (owner.current && props.value === value) setState({ busy: false, result: copied ? "copied" : "failed" })
    if (owner.current && props.value !== value) setState({ busy: false, result: "" })
  }
  return (
    <details class="settings-v2-details" data-component="settings-metadata">
      <summary>{props.title}</summary>
      <div class="settings-v2-actions">
        <ButtonV2 variant="ghost" disabled={state.busy} onClick={() => void copy()}>
          {language.t("settings.metadata.copy")}
        </ButtonV2>
        <span role={state.result === "failed" ? "alert" : "status"}>
          {state.result ? language.t(`settings.metadata.${state.result}`) : ""}
        </span>
      </div>
      <pre class="settings-v2-metadata max-h-80 overflow-auto whitespace-pre-wrap" tabIndex={0}>
        {props.value}
      </pre>
    </details>
  )
}
