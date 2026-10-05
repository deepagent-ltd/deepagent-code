import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { useTheme } from "../context/theme"
import { useTuiI18n } from "../context/i18n"
import { useBindings } from "../keymap"
import { imErrorText } from "./im-errors"

export type IMFormField = { label: string; placeholder?: string; value?: string; multiline?: boolean }

export function DialogIMForm(props: {
  title: string
  description?: string
  fields: IMFormField[]
  submit: (values: string[], active: () => boolean) => Promise<void>
  back: () => void
}) {
  const i18n = useTuiI18n()
  const { theme } = useTheme()
  const inputs: TextareaRenderable[] = []
  const [field, setField] = createSignal(0)
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal("")
  const [target, setTarget] = createSignal<TextareaRenderable>()
  let disposed = false
  onCleanup(() => {
    disposed = true
  })

  const submit = () => {
    if (busy()) return
    setBusy(true)
    setFailure("")
    void props
      .submit(
        inputs.map((input) => input.plainText),
        () => !disposed,
      )
      .catch((error: unknown) => {
        if (!disposed) setFailure(imErrorText(error, i18n))
      })
      .finally(() => {
        if (!disposed) setBusy(false)
      })
  }

  const focus = (direction: number) => {
    if (busy()) return
    setField((current) => (current + direction + props.fields.length) % props.fields.length)
  }

  useBindings(() => ({
    target,
    priority: 2,
    bindings: [
      { key: "return", cmd: submit },
      { key: "tab", cmd: () => focus(1) },
      { key: "shift+tab", cmd: () => focus(-1) },
      { key: "escape", cmd: props.back },
    ],
  }))

  onMount(() => {
    setTarget(inputs[0])
  })

  createEffect(() => {
    const selected = inputs[field()]
    inputs.forEach((input) => {
      input.traits = busy() ? { suspend: true, status: "BUSY" } : {}
      if (input !== selected || busy()) input.blur()
    })
    if (!selected || busy()) return
    selected.focus()
    setTarget(selected)
  })

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        {props.title}
      </text>
      <Show when={props.description}>
        <text fg={theme.textMuted} wrapMode="word">
          {props.description}
        </text>
      </Show>
      <For each={props.fields}>
        {(item, index) => (
          <box>
            <text fg={theme.text}>{item.label}</text>
            <textarea
              id={`im-field-${index()}`}
              height={item.multiline ? 3 : 1}
              initialValue={item.value ?? ""}
              placeholder={item.placeholder}
              placeholderColor={theme.textMuted}
              textColor={theme.text}
              cursorColor={theme.primary}
              ref={(input: TextareaRenderable) => {
                inputs[index()] = input
              }}
              onMouseDown={() => {
                if (!busy()) setField(index())
              }}
            />
          </box>
        )}
      </For>
      <Show when={failure()}>
        <text fg={theme.error} wrapMode="word">
          {failure()}
        </text>
      </Show>
      <text fg={theme.textMuted}>{busy() ? i18n.t("tui.im.working") : i18n.t("tui.im.submit")}</text>
    </box>
  )
}
