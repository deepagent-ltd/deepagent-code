import { createEffect, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@deepagent-code/ui/v2/button-v2"
import { TextInputV2 } from "@deepagent-code/ui/v2/text-input-v2"
import { ConfigIM } from "@deepagent-code/core/config/im"
import { useLanguage } from "@/context/language"
import type { IMFacadeStatus } from "@/utils/im-client"

export function SettingsIMService(props: {
  configured: () => string | null | undefined
  service: () => IMFacadeStatus["service"]
  current: () => boolean
  save: (url: string | null) => Promise<unknown>
}) {
  const language = useLanguage()
  const owner = { active: true }
  const [state, setState] = createStore({
    address: "",
    dirty: false,
    busy: false,
    result: "" as "" | "saved" | "disabled" | "invalid" | "busy" | "failed",
  })
  const text = (key: string) => language.t(`settings.im.service.${key}` as Parameters<typeof language.t>[0])
  const current = () => owner.active && props.current()
  createEffect(() => {
    const address = props.configured() ?? props.service()?.url ?? ""
    if (!state.dirty && !state.busy) setState("address", address)
  })
  onCleanup(() => (owner.active = false))
  const save = (disabled = false) => {
    if (!current() || state.busy) return
    const url = disabled ? null : ConfigIM.normalizeServiceURL(state.address.trim())
    if (url === undefined) {
      setState("result", "invalid")
      return
    }
    setState({ busy: true, result: "" })
    void props.save(url).then(
      () => {
        if (!current()) return
        setState({ busy: false, dirty: false, result: disabled ? "disabled" : "saved" })
      },
      (error: unknown) => {
        if (!current()) return
        const code =
          error && typeof error === "object" && "data" in error && error.data && typeof error.data === "object"
            ? "code" in error.data
              ? error.data.code
              : undefined
            : undefined
        setState({ busy: false, result: code === "im_service_busy" ? "busy" : "failed" })
      },
    )
  }

  return (
    <section class="settings-v2-section flex flex-col gap-3" data-component="settings-im-service">
      <h3 class="settings-v2-section-title">{text("title")}</h3>
      <p class="text-12-regular text-text-weak">{text("description")}</p>
      <label class="flex flex-col gap-1 text-12-regular">
        {text("address")}
        <TextInputV2
          type="url"
          value={state.address}
          aria-label={text("address")}
          autocomplete="off"
          spellcheck={false}
          disabled={state.busy || !current()}
          invalid={state.result === "invalid"}
          onInput={(event) => setState({ address: event.currentTarget.value, dirty: true, result: "" })}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.isComposing) return
            event.preventDefault()
            save()
          }}
        />
      </label>
      <p class="break-all text-12-regular text-text-weak" data-slot="im-service-current">
        {text("current")}: {props.service()?.url ?? text(props.service() ? "none" : "unknown")}
      </p>
      <Show when={props.service()?.source === "environment"}>
        <p class="text-12-regular text-text-weak">{text("environment")}</p>
      </Show>
      <Show when={props.service()?.reconnectRequired}>
        <p role="status" class="text-12-regular text-text-weak">
          {text("reconnect")}
        </p>
      </Show>
      <div class="flex items-center gap-2">
        <ButtonV2
          variant="contrast"
          disabled={state.busy || !current() || !state.address.trim()}
          onClick={() => save()}
        >
          {text("save")}
        </ButtonV2>
        <ButtonV2
          variant="neutral"
          disabled={state.busy || !current() || props.configured() === null}
          onClick={() => save(true)}
        >
          {text("disable")}
        </ButtonV2>
      </div>
      <Show when={state.result}>
        <p role={["saved", "disabled"].includes(state.result) ? "status" : "alert"} class="text-12-regular">
          {text(state.result)}
        </p>
      </Show>
    </section>
  )
}
