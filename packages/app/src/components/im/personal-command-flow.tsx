import { batch, createEffect, on, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@deepagent-code/ui/button"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useLayout } from "@/context/layout"
import { ServerConnection, useServer } from "@/context/server"
import { useLocation, useNavigate } from "@solidjs/router"
import { SessionRouteKey, SessionStateKey } from "@/utils/server-scope"
import { base64Encode } from "@deepagent-code/core/util/encode"
import { PersonalCommandEditor, type PersonalCommandClient } from "./personal-command-editor"
import type { IMDacSessionSchema } from "@deepagent-code/core/im/dac-session.schema"
import type { DacDraft, DacBinding, DacCommand } from "./personal-command"

export function PersonalCommandFlow(props: {
  client: PersonalCommandClient & {
    dacReplyRetry: PersonalCommandClient["dacCommand"]
    dacReplyReconcile?: (
      groupID: string,
      commandID: string,
      cursor: string | undefined,
      signal: AbortSignal,
    ) => Promise<IMDacSessionSchema.ReplyReconcileResponse>
  }
  groupID: string
  draft: DacDraft
  autoSubmit: boolean
  showReturn?: boolean
  bookmark: (targetPath: string) => void
  active: () => boolean
  onClose: () => void
}) {
  const sdk = useSDK()
  const server = useServer()
  const layout = useLayout()
  const location = useLocation()
  const navigate = useNavigate()
  const dialog = useDialog()
  const language = useLanguage()
  const scope = props.client.scope()
  const captured = { client: sdk.client, sdkScope: sdk.scope, directory: sdk.directory, server: server.scope() }
  const returnPath = `${location.pathname}${location.search}${location.hash}`
  const requests = new AbortController()
  const [state, setState] = createStore({
    alive: true,
    opened: false,
    targetPath: "",
    invalid: false,
    replyBusy: false,
    replyUnknown: false,
    reconciliation: undefined as IMDacSessionSchema.ReplyReconcileResponse | undefined,
  })
  const current = () =>
    state.alive &&
    props.active() &&
    props.client.scope() === scope &&
    sdk.client === captured.client &&
    sdk.scope === captured.sdkScope &&
    sdk.directory === captured.directory &&
    server.scope() === captured.server &&
    ServerConnection.local(server.current)
  const close = () => {
    if (!state.opened) props.onClose()
  }
  const open = (value: DacBinding | DacCommand) => {
    if (
      !current() ||
      !value.sessionID ||
      value.groupID !== props.groupID ||
      value.directory !== captured.directory ||
      value.workspaceID !== (scope.workspace ?? null)
    )
      return
    const dir = base64Encode(value.directory)
    const targetPath = `/${dir}/session/${encodeURIComponent(value.sessionID)}`
    props.bookmark(targetPath)
    batch(() => {
      setState({ opened: true, targetPath })
      dialog.close()
      layout
        .view(() => SessionStateKey.from(captured.sdkScope, SessionRouteKey.fromRoute(dir, value.sessionID!)))
        .rightPanel.open("im")
      navigate(targetPath)
    })
  }
  const retryReply = async (send: boolean) => {
    const original = props.draft.state.command
    if (!original || !current() || state.replyBusy) return
    if (
      send &&
      (state.replyUnknown ||
        original.replyStatus !== "dead" ||
        !original.activityID ||
        !original.finalMessageID ||
        original.state !== "admitted")
    )
      return
    setState({ replyBusy: true, ...(send ? { replyUnknown: true } : {}) })
    try {
      const value = await (send ? props.client.dacReplyRetry : props.client.dacCommand)(
        props.groupID,
        original.commandID,
        AbortSignal.any([requests.signal, AbortSignal.timeout(15_000)]),
      )
      if (!current() || props.draft.state.command?.commandID !== original.commandID) return
      if (
        value.commandID !== original.commandID ||
        value.groupID !== props.groupID ||
        value.bindingID !== original.bindingID ||
        value.sessionID !== original.sessionID ||
        value.inputID !== original.inputID ||
        value.projectID !== original.projectID ||
        value.directory !== captured.directory ||
        value.workspaceID !== (scope.workspace ?? null) ||
        value.activityID !== original.activityID ||
        value.finalMessageID !== original.finalMessageID ||
        value.state !== original.state ||
        value.delivery !== original.delivery
      )
        throw new Error("changed")
      batch(() => {
        props.draft.setState("command", value)
        setState("replyUnknown", false)
      })
    } catch {
      if (current()) setState("replyUnknown", true)
    } finally {
      if (current()) setState("replyBusy", false)
    }
  }
  createEffect(
    on(
      () => props.draft.state.command?.commandID,
      () => setState("reconciliation", undefined),
    ),
  )
  const reconcileReply = async () => {
    const original = props.draft.state.command
    if (
      !current() ||
      state.replyBusy ||
      !original ||
      original.state !== "admitted" ||
      !original.finalMessageID ||
      !props.client.dacReplyReconcile
    )
      return
    setState("replyBusy", true)
    try {
      const value = await props.client.dacReplyReconcile(
        props.groupID,
        original.commandID,
        state.reconciliation?.nextCursor ?? undefined,
        AbortSignal.any([requests.signal, AbortSignal.timeout(30_000)]),
      )
      if (!current() || props.draft.state.command?.commandID !== original.commandID) return
      if (
        !(
          [
            "commandID",
            "groupID",
            "bindingID",
            "sessionID",
            "inputID",
            "projectID",
            "directory",
            "workspaceID",
            "activityID",
            "finalMessageID",
            "state",
            "delivery",
          ] as const
        ).every((key) => value.command[key] === original[key])
      )
        throw new Error("changed")
      batch(() => {
        props.draft.setState("command", value.command)
        setState({ reconciliation: value, replyUnknown: false })
      })
    } catch {
      if (current()) setState("replyUnknown", true)
    } finally {
      if (current()) setState("replyBusy", false)
    }
  }
  onMount(() =>
    dialog.show(
      () => (
        <PersonalCommandEditor
          client={props.client}
          groupID={props.groupID}
          draft={props.draft}
          current={current}
          autoSubmit={props.autoSubmit}
          open={open}
          close={() => dialog.close()}
        />
      ),
      close,
    ),
  )
  createEffect(() => {
    if (!current()) {
      setState("invalid", true)
      requests.abort()
    }
  })
  onCleanup(() => {
    setState("alive", false)
    requests.abort()
  })
  createEffect(() => {
    const commandID = props.draft.state.command?.commandID
    const replyStatus = props.draft.state.command?.replyStatus
    if (
      !commandID ||
      !state.opened ||
      state.invalid ||
      state.replyUnknown ||
      replyStatus === "unknown" ||
      replyStatus === "dead" ||
      replyStatus === "delivered"
    )
      return
    const poll = { timer: undefined as ReturnType<typeof setTimeout> | undefined, closed: false }
    const abort = new AbortController()
    onCleanup(() => {
      poll.closed = true
      abort.abort()
      if (poll.timer) clearTimeout(poll.timer)
    })
    const read = async () => {
      if (poll.closed || !current()) return
      if (document.visibilityState === "hidden") {
        poll.timer = setTimeout(() => void read(), 5000)
        return
      }
      try {
        const previous = props.draft.state.command
        const value = await props.client.dacCommand(
          props.groupID,
          commandID,
          AbortSignal.any([abort.signal, requests.signal, AbortSignal.timeout(10_000)]),
        )
        if (poll.closed || !current() || previous?.commandID !== props.draft.state.command?.commandID) return
        if (
          value.commandID !== commandID ||
          value.groupID !== props.groupID ||
          value.inputID !== previous?.inputID ||
          value.bindingID !== previous.bindingID ||
          value.sessionID !== previous.sessionID ||
          value.directory !== captured.directory ||
          value.workspaceID !== (scope.workspace ?? null)
        )
          return
        props.draft.setState("command", value)
        if (
          value.replyStatus === "delivered" ||
          value.replyStatus === "dead" ||
          value.replyStatus === "unknown" ||
          value.state === "rejected"
        )
          return
      } catch {
        // Observation failures cannot restart execution or turn a prior final into a new answer.
      }
      if (!poll.closed && current()) poll.timer = setTimeout(() => void read(), 5000)
    }
    void read()
  })
  return (
    <Show when={state.opened}>
      <div class="px-3 py-2 border-b border-border-weaker-base flex flex-col gap-2 text-12-regular">
        <p>{language.t("im.dac.private")}</p>
        <Show when={props.draft.state.command}>
          {(command) => (
            <p role="status">
              {language.t(
                state.replyUnknown || command().replyStatus === "unknown"
                  ? "im.dac.reply.unknown"
                  : command().replyStatus === "delivered"
                    ? "im.dac.reply.delivered"
                    : command().replyStatus === "dead"
                      ? "im.dac.reply.dead"
                      : command().replyStatus === "pending"
                        ? "im.dac.reply.pending"
                        : command().replyStatus === "delivering"
                          ? "im.dac.reply.delivering"
                          : "im.dac.state.admitted",
              )}
            </p>
          )}
        </Show>
        <Show when={props.draft.state.command?.replyStatus === "dead" && !state.replyUnknown}>
          <Button
            size="small"
            variant="secondary"
            disabled={
              !current() ||
              state.replyBusy ||
              !props.draft.state.command?.finalMessageID ||
              !props.draft.state.command?.activityID
            }
            onClick={() => void retryReply(true)}
          >
            {language.t("im.dac.reply.retry")}
          </Button>
        </Show>
        <Show when={state.replyUnknown || props.draft.state.command?.replyStatus === "unknown"}>
          <Button
            size="small"
            variant="secondary"
            disabled={!current() || state.replyBusy}
            onClick={() => void retryReply(false)}
          >
            {language.t("im.dac.check")}
          </Button>
        </Show>
        <Show
          when={
            props.draft.state.command?.state === "admitted" &&
            props.draft.state.command?.finalMessageID &&
            props.draft.state.command?.replyStatus !== "delivered" &&
            props.client.dacReplyReconcile
          }
        >
          <Button
            size="small"
            variant="secondary"
            disabled={!current() || state.replyBusy}
            onClick={() => void reconcileReply()}
          >
            {language.t(state.reconciliation?.hasMore ? "im.dac.reply.reconcileMore" : "im.dac.reply.reconcile")}
          </Button>
          <p>{language.t("im.dac.reply.reconcileHelp")}</p>
        </Show>
        <Show when={state.reconciliation}>
          {(value) => (
            <p role="status">
              {language.t("im.dac.reply.reconcileCount", {
                confirmed: value().confirmedParts,
                total: value().totalParts,
              })}
            </p>
          )}
        </Show>
        <Show when={state.invalid}>
          <p role="alert">{language.t("im.dac.scopeChanged")}</p>
        </Show>
        <Show when={props.showReturn !== false}>
          <Button
            size="small"
            variant="secondary"
            disabled={state.invalid || !current() || location.pathname !== state.targetPath}
            onClick={() => {
              if (!current()) return
              navigate(returnPath)
              props.onClose()
            }}
          >
            {language.t("im.dac.returnToChat")}
          </Button>
        </Show>
      </div>
    </Show>
  )
}
