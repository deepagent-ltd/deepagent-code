import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { useTheme } from "../context/theme"
import { useTuiI18n } from "../context/i18n"
import { useBindings } from "../keymap"
import { IMSecretInput } from "./im-secret-input"
import { imErrorText } from "./im-errors"
import type { IMActivation } from "./im-activation"

export function DialogIMActivation(props: { flow: IMActivation; queryOnly?: boolean; back: () => void }) {
  const { theme } = useTheme()
  const i18n = useTuiI18n()
  const [nameInput, setNameInput] = createSignal<TextareaRenderable>()
  const [queryInput, setQueryInput] = createSignal<TextareaRenderable>()
  const [field, setField] = createSignal(0)
  const [queryID, setQueryID] = createSignal("")
  const [failure, setFailure] = createSignal<unknown>()
  let disposed = false
  onCleanup(() => { disposed = true })
  const run = (action: () => Promise<unknown>) => {
    setFailure(undefined)
    void action().catch((error: unknown) => { if (!disposed) setFailure(() => error) })
  }
  const refresh = () => run(() => props.flow.refresh(props.flow.state.transactionID ?? queryID()))
  const submit = () => run(() => props.flow.submit())
  useBindings(() => ({ priority: 2, bindings: [
    { key: "return", cmd: () => { if (props.queryOnly || props.flow.state.uncertain) refresh(); else submit() } },
    { key: "tab", cmd: () => setField((current) => current === 0 ? 1 : 0) },
    { key: "shift+tab", cmd: () => setField((current) => current === 0 ? 1 : 0) },
    { key: "alt+c", cmd: () => props.flow.update({ confirmed: !props.flow.state.confirmed }) },
    { key: "alt+m", cmd: () => props.flow.update({ method: props.flow.state.method === "api_key"
      ? "activation_code" : "api_key", credential: "" }) },
    { key: "ctrl+r", cmd: refresh },
    { key: "ctrl+l", cmd: () => run(() => props.flow.load()) },
    { key: "escape", cmd: props.back },
  ] }))
  onMount(() => run(() => props.flow.load(!props.queryOnly)))
  createEffect(() => {
    const editor = nameInput()
    if (!editor || editor.isDestroyed) return
    if (editor.plainText !== props.flow.state.name) editor.setText(props.flow.state.name)
    editor.traits = props.flow.editable() ? {} : { suspend: true, status: "BUSY" }
    if (!props.queryOnly && field() === 0 && props.flow.editable()) editor.focus()
    else editor.blur()
  })
  createEffect(() => {
    const editor = queryInput()
    if (!editor || editor.isDestroyed) return
    editor.traits = props.flow.state.busy || !!props.flow.state.transactionID ? { suspend: true, status: "BUSY" } : {}
    if (props.queryOnly && !props.flow.state.busy && !props.flow.state.transactionID) editor.focus()
    else editor.blur()
  })
  return <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
    <text fg={theme.text} attributes={TextAttributes.BOLD}>
      {i18n.t(props.queryOnly ? "tui.im.activation.resume" : "tui.im.activation.title")}
    </text>
    <text fg={theme.textMuted} wrapMode="word">{i18n.t("tui.im.activation.notice")}</text>
    <Show when={!props.queryOnly && !props.flow.state.uncertain && props.flow.state.transaction?.state !== "succeeded"}>
      <Show when={props.flow.state.quote}>
        {(quote) => <text fg={theme.textMuted} wrapMode="word">{i18n.t("tui.im.activation.quote", {
          credits: quote().priceCredits, expiry: new Date(quote().expiresAt).toLocaleString(),
        })}</text>}
      </Show>
      <text fg={theme.primary} onMouseUp={() => props.flow.update({ method: props.flow.state.method === "api_key"
        ? "activation_code" : "api_key", credential: "" })}>
        {i18n.t(props.flow.state.method === "api_key" ? "tui.im.activation.apiKey" : "tui.im.activation.code")}
      </text>
      <box>
        <text fg={theme.text}>{i18n.t("tui.im.activation.name")}</text>
        <textarea id="im-activation-name" height={1} ref={setNameInput} textColor={theme.text}
          onContentChange={() => props.flow.update({ name: nameInput()?.plainText ?? "" })} />
      </box>
      <IMSecretInput value={props.flow.state.credential} setValue={(credential) => props.flow.update({ credential })}
        active={field() === 1} locked={!props.flow.editable()} label={i18n.t("tui.im.activation.credential")} />
      <Show when={props.flow.state.method === "api_key"}>
      <text fg={theme.primary} onMouseUp={() => props.flow.update({ confirmed: !props.flow.state.confirmed })}>
        {props.flow.state.confirmed ? "[x] " : "[ ] "}
        {i18n.t("tui.im.activation.confirm")}
      </text>
      </Show>
      <text fg={theme.textMuted} wrapMode="word">{i18n.t(props.flow.state.method === "api_key"
        ? "tui.im.activation.confirmHint" : "tui.im.activation.codeHint")}</text>
      <text fg={theme.primary} onMouseUp={() => run(() => props.flow.load())}>
        {i18n.t("tui.im.activation.quoteRefresh")}
      </text>
    </Show>
    <Show when={props.queryOnly && !props.flow.state.transactionID}>
      <text fg={theme.text}>{i18n.t("tui.im.activation.statusID")}</text>
      <textarea id="im-activation-status-id" height={1} ref={setQueryInput}
        onContentChange={() => setQueryID(queryInput()?.plainText ?? "")} textColor={theme.text} />
    </Show>
    <Show when={props.flow.state.transactionID}>
      {(id) => <text fg={theme.textMuted} wrapMode="word">{i18n.t("tui.im.activation.transaction", { id: id() })}</text>}
    </Show>
    <Show when={props.flow.state.transaction}>
      {(transaction) => <text fg={theme.textMuted} wrapMode="word">{i18n.t("tui.im.activation.state", {
        state: transaction().state, credits: transaction().chargedCredits ?? "—",
      })}</text>}
    </Show>
    <Show when={props.flow.state.uncertain}>
      <text fg={theme.warning} wrapMode="word">{i18n.t("tui.im.activation.unknown")}</text>
    </Show>
    <Show when={props.flow.state.transaction?.state === "succeeded" && props.flow.state.transaction.credentialStored}>
      <text fg={theme.success} wrapMode="word">{i18n.t("tui.im.activation.complete")}</text>
    </Show>
    <Show when={props.flow.state.transaction?.state === "rejected"}>
      <text fg={theme.warning}>{i18n.t("tui.im.activation.failed")}</text>
    </Show>
    <Show when={failure() ?? props.flow.state.failure}>
      {(failure) => <text fg={theme.error} wrapMode="word">{imErrorText(failure(), i18n)}</text>}
    </Show>
    <Show when={!props.queryOnly && !props.flow.state.uncertain && props.flow.state.transaction?.state !== "succeeded"}>
      <text fg={theme.primary} onMouseUp={submit}>{props.flow.state.busy ? i18n.t("tui.im.working")
        : i18n.t(props.flow.state.method === "api_key" ? "tui.im.activation.submit" : "tui.im.activation.redeem")}</text>
    </Show>
    <text fg={theme.primary} onMouseUp={refresh}>{i18n.t("tui.im.activation.refresh")}</text>
    <text fg={theme.textMuted} onMouseUp={props.back}>{i18n.t("tui.im.activation.back")}</text>
  </box>
}
