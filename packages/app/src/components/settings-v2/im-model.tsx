import { onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { SelectV2 } from "@deepagent-code/ui/v2/select-v2"
import { useLanguage } from "@/context/language"
import { SettingsRowV2 } from "./parts/row"

export type IMModelOption = { value: string; label: string }

export function SettingsIMModel(props: {
  options: () => IMModelOption[]
  value: () => string | undefined
  current: () => boolean
  save: (model: string) => Promise<unknown>
}) {
  const language = useLanguage()
  const owner = { active: true }
  const [state, setState] = createStore({ busy: false, result: "" as "" | "saved" | "failed" })
  const current = () => owner.active && props.current()
  const selected = () => props.options().find((model) => model.value === props.value())
  onCleanup(() => (owner.active = false))

  return (
    <div class="flex flex-col gap-2" data-component="settings-im-model">
      <SettingsRowV2
        title={language.t("settings.im.model.title")}
        description={language.t("settings.im.model.description")}
      >
        <SelectV2
          options={props.options()}
          current={selected()}
          value={(model) => model.value}
          label={(model) => model.label}
          placeholder={language.t("settings.im.model.select")}
          disabled={state.busy || !current() || props.options().length === 0}
          onSelect={(model) => {
            if (!current() || state.busy || !model || !props.options().some((item) => item.value === model.value))
              return
            if (model.value === props.value()) return
            setState({ busy: true, result: "" })
            void props.save(model.value).then(
              () => {
                if (current()) setState({ busy: false, result: "saved" })
              },
              () => {
                if (current()) setState({ busy: false, result: "failed" })
              },
            )
          }}
        />
      </SettingsRowV2>
      <Show when={props.options().length === 0}>
        <p role="status" class="text-12-regular text-text-weak">
          {language.t("settings.im.model.empty")}
        </p>
      </Show>
      <Show when={props.value() && !selected()}>
        <p role="alert" class="text-12-regular text-text-weak">
          {language.t("settings.im.model.missing")}: {props.value()}
        </p>
      </Show>
      <Show when={state.result}>
        <p role={state.result === "failed" ? "alert" : "status"} class="text-12-regular">
          {language.t(state.result === "failed" ? "settings.im.model.failed" : "settings.im.model.saved")}
        </p>
      </Show>
    </div>
  )
}
