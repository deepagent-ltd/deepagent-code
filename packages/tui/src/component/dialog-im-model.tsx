import { createResource, createSignal, onCleanup } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { useTuiI18n } from "../context/i18n"
import { imErrorText } from "./im-errors"
import type { IMClient } from "./im-client"

export function DialogIMModel(props: { client: IMClient; back: () => void }) {
  const i18n = useTuiI18n()
  const captured = props.client.scope()
  const abort = new AbortController()
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<unknown>()
  onCleanup(() => abort.abort())
  const current = () => !abort.signal.aborted && props.client.scope() === captured
  const signal = () => AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)])
  const [settings, { refetch }] = createResource(() => props.client.imModelSettings(signal()))
  const select = async (model: string) => {
    if (busy() || !current()) return
    setBusy(true)
    setFailure(undefined)
    try {
      await props.client.setIMModel(model, signal())
      if (current()) await refetch()
    } catch (error) {
      if (current()) setFailure(() => error)
    } finally {
      if (current()) setBusy(false)
    }
  }
  return <DialogSelect
    title={i18n.t("tui.im.model.title")}
    titleView={<box>
      <text>{i18n.t("tui.im.model.title")}</text>
      <text>{i18n.t("tui.im.model.independent")}</text>
      <text>{i18n.t("tui.im.model.current", { model: settings()?.model ?? i18n.t("tui.im.model.unset") })}</text>
      <text>{failure() || settings.error ? imErrorText(failure() ?? settings.error, i18n) : ""}</text>
    </box>}
    locked={busy() || settings.loading}
    current={settings()?.model}
    options={[
      ...(settings()?.models ?? []).map((model) => ({ value: model.id, title: model.name,
        category: model.provider, footer: model.id,
        onSelect: () => { void select(model.id) } })),
      { value: "back", title: i18n.t("tui.im.back"), onSelect: props.back },
    ]}
  />
}
