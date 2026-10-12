import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { useTheme } from "../context/theme"
import { useTuiI18n } from "../context/i18n"
import { useBindings } from "../keymap"
import { imErrorText } from "./im-errors"
import type { IMDacDraft } from "./im-dac-draft"
import type { IMDacCommand } from "./im-client"
import { DialogSelect } from "../ui/dialog-select"

export function DialogIMDac(props: {
  draft: IMDacDraft
  openSession: (sessionID: string) => Promise<void>
  back: () => void
  recentCommands?: readonly IMDacCommand[]
}) {
  const i18n = useTuiI18n()
  const { theme } = useTheme()
  const [target, setTarget] = createSignal<TextareaRenderable>()
  const [failure, setFailure] = createSignal<unknown>()
  const [selecting, setSelecting] = createSignal(false)
  const replyStatus = (command: IMDacCommand) =>
    command.replyStatus === "unknown" ? i18n.t("tui.im.transport.unknown") : command.replyStatus ?? "—"
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  const run = (action: () => Promise<unknown>) => {
    setFailure(undefined)
    void action().catch((error: unknown) => {
      if (!disposed) setFailure(() => error)
    })
  }
  const submit = () =>
    run(async () => {
      const checkingReply = props.draft.state.command?.replyStatus === "unknown"
      const command = await props.draft.submit()
      if (disposed || checkingReply || command?.state !== "admitted" || !command.sessionID) return
      await props.openSession(command.sessionID)
    })
  const open = () =>
    run(async () => {
      const sessionID = props.draft.state.command?.sessionID
      if (sessionID) await props.openSession(sessionID)
    })
  useBindings(() => ({
    // The pending draft must keep retry, status and back reachable while its editor is suspended.
    priority: 2,
    enabled: !selecting(),
    bindings: [
      { key: "return", cmd: submit },
      { key: "alt+q", cmd: () => props.draft.update({ delivery: "queue" }) },
      { key: "alt+s", cmd: () => props.draft.update({ delivery: "steer" }) },
      { key: "alt+n", cmd: () => props.draft.update({ newSession: !props.draft.state.newSession }) },
      { key: "ctrl+r", cmd: () => run(() => props.draft.refresh()) },
      { key: "ctrl+o", cmd: open },
      { key: "ctrl+y", cmd: () => run(() => props.draft.retryReply()) },
      {
        key: "ctrl+h",
        cmd: () => {
          if (
            props.recentCommands?.length &&
            !props.draft.state.busy &&
            !props.draft.state.uncertain &&
            !props.draft.state.replyUncertain
          )
            setSelecting(true)
        },
      },
      { key: "escape", cmd: props.back },
    ],
  }))
  onMount(() => target()?.focus())
  createEffect(() => {
    const input = target()
    if (!input || input.isDestroyed) return
    if (input.plainText !== props.draft.state.text) input.setText(props.draft.state.text)
    input.traits = props.draft.editable() ? {} : { suspend: true, status: "BUSY" }
    if (props.draft.editable()) input.focus()
    else input.blur()
  })
  return (
    <Show
      when={selecting()}
      fallback={
        <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {i18n.t("tui.im.dac.title")}
          </text>
          <text fg={theme.textMuted} wrapMode="word">
            {i18n.t("tui.im.dac.private")}
          </text>
          <text fg={theme.textMuted} wrapMode="word">
            {props.draft.state.delivery === "queue" ? i18n.t("tui.im.dac.queue") : i18n.t("tui.im.dac.steer")}
            {" · "}
            {props.draft.state.newSession ? i18n.t("tui.im.dac.newSession") : i18n.t("tui.im.dac.sameSession")}
            {" · "}
            {i18n.t("tui.im.dac.references", { count: props.draft.state.referenceMessageIDs.length })}
          </text>
          <textarea
            id="im-dac-draft"
            height={6}
            initialValue={props.draft.state.text}
            placeholder={i18n.t("tui.im.dac.placeholder")}
            placeholderColor={theme.textMuted}
            textColor={theme.text}
            cursorColor={theme.primary}
            ref={setTarget}
            onContentChange={() => props.draft.update({ text: target()?.plainText ?? "" })}
          />
          <Show
            when={props.draft.state.uncertain || props.draft.state.replyUncertain || props.draft.state.command?.replyStatus === "unknown"}
          >
            <text fg={theme.warning} wrapMode="word">
              {i18n.t("tui.im.dac.unknown")}
            </text>
          </Show>
          <Show when={props.draft.state.command}>
            {(command) => (
              <box>
                <text fg={theme.textMuted} wrapMode="word">
                  {i18n.t("tui.im.dac.state", {
                    state: command().state,
                    reply: replyStatus(command()),
                  })}
                </text>
                <Show when={command().sessionID}>
                  <text fg={theme.primary} onMouseUp={open}>
                    {i18n.t("tui.im.dac.open")} (Ctrl+O)
                  </text>
                </Show>
                <Show when={command().finalMessageID}>
                  <text fg={theme.textMuted}>{i18n.t("tui.im.dac.final")}</text>
                </Show>
                <Show
                  when={
                    command().state === "admitted" &&
                    command().replyStatus === "dead" &&
                    command().finalMessageID &&
                    !props.draft.state.busy &&
                    !props.draft.state.replyUncertain
                  }
                >
                  <text fg={theme.primary} onMouseUp={() => run(() => props.draft.retryReply())}>
                    {i18n.t("tui.im.dac.replyRetry")} (Ctrl+Y)
                  </text>
                </Show>
              </box>
            )}
          </Show>
          <Show when={failure() ?? props.draft.state.failure}>
            {(error) => (
              <text fg={theme.error} wrapMode="word">
                {imErrorText(error(), i18n)}
              </text>
            )}
          </Show>
          <text fg={theme.primary} onMouseUp={submit}>
            {props.draft.state.busy
              ? i18n.t("tui.im.working")
              : props.draft.state.uncertain || props.draft.state.replyUncertain || props.draft.state.command?.replyStatus === "unknown"
                ? i18n.t("tui.im.dac.refresh")
                : i18n.t("tui.im.dac.submit")}
          </text>
          <text fg={theme.primary} onMouseUp={() => run(() => props.draft.refresh())}>
            {i18n.t("tui.im.dac.refresh")} (Ctrl+R)
          </text>
          <Show when={props.recentCommands?.length}>
            <text
              fg={theme.primary}
              onMouseUp={() => {
                if (!props.draft.state.busy && !props.draft.state.uncertain && !props.draft.state.replyUncertain)
                  setSelecting(true)
              }}
            >
              {i18n.t("tui.im.dac.recent")} (Ctrl+H)
            </text>
          </Show>
          <text fg={theme.textMuted} wrapMode="word">
            {i18n.t("tui.im.dac.hint")}
          </text>
        </box>
      }
    >
      <DialogSelect
        title={i18n.t("tui.im.dac.recent")}
        current={props.draft.state.commandID}
        options={(props.recentCommands ?? []).map((command) => ({
          title: command.commandID,
          value: command.commandID,
          description: i18n.t("tui.im.dac.state", {
            state: command.state,
            reply: replyStatus(command),
          }),
        }))}
        onSelect={(option) => {
          setSelecting(false)
          run(() => props.draft.inspect(option.value))
        }}
        bindings={[{ key: "escape", cmd: () => setSelecting(false) }]}
      />
    </Show>
  )
}
