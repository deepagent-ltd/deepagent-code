import { onCleanup, onMount, Show } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { Button } from "@deepagent-code/ui/button"
import { Dialog } from "@deepagent-code/ui/dialog"
import { useLanguage } from "@/context/language"
import { IMFacadeRequestError } from "@/utils/im-client"
import type { DacBinding, DacCommand, DacDraft, DacInput } from "./personal-command"
import { Schema } from "effect"
import { IMDacSessionSchema } from "@deepagent-code/core/im/dac-session.schema"

export type PersonalCommandClient = {
  scope: () => { readonly workspace?: string }
  dacBinding: (groupID: string, signal: AbortSignal) => Promise<DacBinding>
  dacSubmit: (groupID: string, input: DacInput, signal: AbortSignal) => Promise<DacCommand>
  dacCommand: (groupID: string, commandID: string, signal: AbortSignal) => Promise<DacCommand>
}

export function PersonalCommandEditor(props: {
  client: PersonalCommandClient
  groupID: string
  draft: DacDraft
  current: () => boolean
  autoSubmit?: boolean
  open: (value: DacBinding | DacCommand) => void
  close: () => void
}) {
  const language = useLanguage()
  const captured = props.client.scope()
  const requests = new AbortController()
  const owner = { active: true }
  const current = () => owner.active && props.current() && captured === props.client.scope()
  const [state, setState] = createStore({
    loading: true,
    busy: false,
    error: "",
    binding: undefined as DacBinding | undefined,
  })
  const signal = () => AbortSignal.any([requests.signal, AbortSignal.timeout(15_000)])
  const failure = (error: unknown) => {
    if (!current()) return
    setState(
      "error",
      error instanceof IMFacadeRequestError &&
        error.status === 409 &&
        (error.code === "command_conflict" || error.code === "task_scope_changed")
        ? "conflict"
        : "unavailable",
    )
  }
  const observe = async () => {
    const commandID = props.draft.state.pending?.commandID ?? props.draft.state.command?.commandID
    if (!current() || state.busy || !state.binding || !commandID) return
    setState({ busy: true, error: "" })
    const original = props.draft.state.pending
    const previous = original ? undefined : props.draft.state.command
    try {
      const command = await props.client.dacCommand(props.groupID, commandID, signal())
      if (
        !current() ||
        props.draft.state.pending !== original ||
        (!original && props.draft.state.command?.commandID !== commandID)
      )
        return
      if (
        command.commandID !== commandID ||
        command.groupID !== props.groupID ||
        command.directory !== state.binding?.directory ||
        command.workspaceID !== state.binding.workspaceID ||
        (previous &&
          (command.bindingID !== previous.bindingID ||
            command.sessionID !== previous.sessionID ||
            command.inputID !== previous.inputID ||
            command.projectID !== previous.projectID))
      )
        throw new Error("changed")
      props.draft.setState("command", command)
      if (command.state !== "pending") props.draft.setState("pending", undefined)
      if (command.state === "admitted" && original?.commandID === command.commandID)
        props.draft.setState({ text: "", reference: undefined, newSession: false })
    } catch (error) {
      failure(error)
    } finally {
      if (current()) setState("busy", false)
    }
  }
  const submit = async () => {
    if (!current() || state.loading || state.busy || !state.binding || !props.draft.state.text.trim()) return
    const original =
      props.draft.state.pending ??
      Object.freeze({
        commandID: `dac-${crypto.randomUUID()}`,
        text: props.draft.state.text,
        delivery: props.draft.state.delivery,
        ...(props.draft.state.reference ? { referenceMessageIDs: [props.draft.state.reference.id] } : {}),
        ...(props.draft.state.newSession ? { newSession: true } : {}),
      })
    if (!Schema.is(IMDacSessionSchema.Submit)(original)) {
      setState("error", "invalid")
      return
    }
    props.draft.setState("pending", original)
    setState({ busy: true, error: "" })
    try {
      const command = await props.client.dacSubmit(props.groupID, unwrap(original), signal())
      if (!current() || props.draft.state.pending?.commandID !== original.commandID) return
      if (
        command.commandID !== original.commandID ||
        command.groupID !== props.groupID ||
        command.directory !== state.binding.directory ||
        command.workspaceID !== state.binding.workspaceID
      )
        throw new Error("changed")
      props.draft.setState("command", command)
      if (command.state === "pending") return
      props.draft.setState("pending", undefined)
      if (command.state === "rejected") return
      props.draft.setState({ text: "", reference: undefined, newSession: false })
      props.open(command)
    } catch (error) {
      if (
        current() &&
        error instanceof IMFacadeRequestError &&
        error.notAdmitted &&
        props.draft.state.pending?.commandID === original.commandID
      )
        props.draft.setState("pending", undefined)
      failure(error)
    } finally {
      if (current()) setState("busy", false)
    }
  }
  onCleanup(() => {
    owner.active = false
    requests.abort()
  })
  const readBinding = (submitOnReady: boolean) => {
    if (!current() || state.busy) return
    setState({ loading: true, error: "" })
    return props.client
      .dacBinding(props.groupID, signal())
      .then(async (binding) => {
        if (!current()) return
        if (binding.groupID !== props.groupID) throw new Error("changed")
        if (
          binding.recentCommands?.some(
            (command) =>
              command.groupID !== binding.groupID ||
              command.projectID !== binding.projectID ||
              command.bindingID !== binding.bindingID ||
              command.directory !== binding.directory ||
              command.workspaceID !== binding.workspaceID,
          ) ||
          new Set(binding.recentCommands?.map((command) => command.commandID)).size !==
            (binding.recentCommands?.length ?? 0)
        )
          throw new Error("changed")
        setState({ binding, loading: false })
        const recovering = !!props.draft.state.pending
        if (!recovering && !props.draft.state.command && binding.recentCommands?.length)
          props.draft.setState("command", binding.recentCommands[0])
        if (props.draft.state.command || props.draft.state.pending) await observe()
        if (submitOnReady && !recovering && props.draft.state.text.trim() && !props.draft.state.pending) await submit()
      })
      .catch(failure)
      .finally(() => {
        if (current()) setState("loading", false)
      })
  }
  onMount(() => void readBinding(!!props.autoSubmit))

  return (
    <Dialog title={language.t("im.dac.title")} fit>
      <div class="flex flex-col gap-3 px-4 pb-4 min-w-0">
        <p class="text-12-regular text-text-weak">{language.t("im.dac.private")}</p>
        <p class="text-12-regular">{language.t("im.dac.destination")}</p>
        <Show
          when={state.binding}
          fallback={
            <Show when={state.loading}>
              <p role="status">{language.t("im.dac.loading")}</p>
            </Show>
          }
        >
          {(binding) => (
            <div class="text-12-regular break-all">
              <p>
                {language.t("im.dac.project")}: {binding().directory}
              </p>
              <Show when={binding().sessionID}>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={!current() || state.busy}
                  onClick={() => {
                    if (current()) props.open(binding())
                  }}
                >
                  {language.t("im.dac.open")}
                </Button>
              </Show>
            </div>
          )}
        </Show>
        <Show when={props.draft.state.reference}>
          {(reference) => (
            <blockquote class="border-l-2 border-border-base pl-3 text-12-regular max-h-24 overflow-auto whitespace-pre-wrap break-words">
              {reference().content}
            </blockquote>
          )}
        </Show>
        <label class="flex flex-col gap-1 text-12-regular">
          {language.t("im.dac.command")}
          <code>/dac</code>
          <textarea
            aria-label={language.t("im.dac.command")}
            class="w-full min-h-28"
            maxLength={65536}
            value={props.draft.state.text}
            disabled={state.busy || !!props.draft.state.pending}
            onInput={(event) => props.draft.setState("text", event.currentTarget.value)}
          />
        </label>
        <label class="flex items-center gap-2 text-12-regular">
          {language.t("im.dac.delivery")}
          <select
            aria-label={language.t("im.dac.delivery")}
            value={props.draft.state.delivery}
            disabled={state.busy || !!props.draft.state.pending}
            onChange={(event) =>
              props.draft.setState("delivery", event.currentTarget.value === "steer" ? "steer" : "queue")
            }
          >
            <option value="queue">{language.t("im.dac.queue")}</option>
            <option value="steer">{language.t("im.dac.steer")}</option>
          </select>
        </label>
        <p class="text-12-regular text-text-weak">
          {language.t(props.draft.state.delivery === "queue" ? "im.dac.queueHint" : "im.dac.steerHint")}
        </p>
        <Show when={state.binding?.sessionID}>
          <label class="flex items-center gap-2 text-12-regular">
            <input
              type="checkbox"
              checked={props.draft.state.newSession}
              disabled={state.busy || !!props.draft.state.pending}
              onChange={(event) => props.draft.setState("newSession", event.currentTarget.checked)}
            />
            {language.t("im.dac.newSession")}
          </label>
        </Show>
        <Show when={props.draft.state.command}>
          {(command) => (
            <div role="status" class="text-12-regular">
              <Show when={state.binding?.recentCommands?.length}>
                <label class="flex flex-col gap-1 mb-2">
                  {language.t("im.dac.recent")}
                  <select
                    aria-label={language.t("im.dac.recent")}
                    value={command().commandID}
                    disabled={!current() || state.busy || !!props.draft.state.pending}
                    onChange={(event) => {
                      if (!current() || state.busy || props.draft.state.pending) return
                      const selected = state.binding?.recentCommands?.find(
                        (item) => item.commandID === event.currentTarget.value,
                      )
                      if (!selected) return
                      props.draft.setState("command", selected)
                      void observe()
                    }}
                  >
                    {state.binding?.recentCommands?.map((item) => (
                      <option value={item.commandID}>
                        {`${item.commandID.slice(-8)} · ${language.t(`im.dac.${item.delivery}`)} · ${language.t(`im.dac.state.${item.state}`)}`}
                      </option>
                    ))}
                  </select>
                </label>
              </Show>
              <p>{language.t(`im.dac.state.${command().state}`)}</p>
              <Show when={command().replyStatus}>
                <p>{language.t(`im.dac.reply.${command().replyStatus!}`)}</p>
              </Show>
              <Show when={command().state === "admitted"}>
                <Button
                  size="small"
                  variant="secondary"
                  disabled={!current() || state.busy}
                  onClick={() => {
                    if (current()) props.open(command())
                  }}
                >
                  {language.t("im.dac.open")}
                </Button>
              </Show>
            </div>
          )}
        </Show>
        <Show when={state.error}>
          <p role="alert">
            {language.t(
              state.error === "conflict"
                ? "im.dac.error.conflict"
                : state.error === "invalid"
                  ? "im.dac.error.invalid"
                  : "im.dac.error.unavailable",
            )}
          </p>
        </Show>
        <Show when={!state.binding && !state.loading && state.error}>
          <Button
            variant="secondary"
            disabled={!current() || state.busy}
            onClick={() => {
              if (!state.loading) void readBinding(false)
            }}
          >
            {language.t("common.refresh")}
          </Button>
        </Show>
        <Show when={props.draft.state.pending}>
          <p class="text-12-regular text-text-weak">{language.t("im.dac.unknown")}</p>
        </Show>
        <Show when={props.draft.state.pending || props.draft.state.command}>
          <Button variant="secondary" disabled={state.busy || !current()} onClick={() => void observe()}>
            {language.t("im.dac.check")}
          </Button>
        </Show>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={props.close}>
            {language.t("common.close")}
          </Button>
          <Button
            disabled={state.loading || state.busy || !current() || !state.binding || !props.draft.state.text.trim()}
            onClick={() => void submit()}
          >
            {language.t(props.draft.state.pending ? "im.dac.retry" : "im.dac.send")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
