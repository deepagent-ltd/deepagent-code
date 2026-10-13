import { TextareaRenderable } from "@opentui/core"
import { createEffect, createSignal } from "solid-js"
import { useTheme } from "../context/theme"
import { useBindings } from "../keymap"

// Only mask characters enter the renderable buffer; terminal capture and editor copy cannot expose the credential.
export function IMSecretInput(props: {
  value: string
  setValue: (value: string) => void
  active: boolean
  locked: boolean
  label: string
}) {
  const { theme } = useTheme()
  const [input, setInput] = createSignal<TextareaRenderable>()
  useBindings(() => ({ target: input, priority: 3, bindings: [
    { key: "ctrl+u", cmd: () => { if (!props.locked) props.setValue("") } },
    { key: "backspace", cmd: () => {
      if (!props.locked) props.setValue(Array.from(props.value).slice(0, -1).join(""))
    } },
  ] }))
  createEffect(() => {
    const editor = input()
    if (!editor) return
    editor.setText("*".repeat(Array.from(props.value).length))
    editor.gotoLineEnd()
    editor.traits = props.locked ? { suspend: true, status: "BUSY" } : {}
    if (props.active && !props.locked) editor.focus()
    else editor.blur()
  })
  return <box>
    <text fg={theme.text}>{props.label}</text>
    <textarea id="im-activation-credential" height={1} ref={setInput} textColor={theme.text}
      cursorColor={theme.primary} selectable={false}
      onKeyDown={(event) => {
        if (["return", "tab", "escape"].includes(event.name)) return
        event.preventDefault()
        if (props.locked) return
        if (event.name === "backspace") {
          props.setValue(Array.from(props.value).slice(0, -1).join(""))
          return
        }
        if (event.ctrl && event.name === "u") { props.setValue(""); return }
        if (event.ctrl || event.meta || event.super || Array.from(event.sequence).length !== 1 ||
          /[\s\x00-\x1f\x7f]/u.test(event.sequence) || props.value.length >= 4096) return
        props.setValue(props.value + event.sequence)
      }}
      onPaste={(event) => {
        event.preventDefault()
        if (props.locked) return
        const value = new TextDecoder().decode(event.bytes)
        if (/[\s\x00-\x1f\x7f]/u.test(value) || props.value.length + value.length > 4096) return
        props.setValue(props.value + value)
      }} />
  </box>
}
