import type {
  AttentionCapability,
  AttentionItem,
  AttentionList,
  SessionMessage,
  SessionMessagesResponse,
  SessionV2Info,
  TaskHumanControlInput,
  DeepagentGoalPauseResponses,
} from "@deepagent-code/sdk"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useBindings } from "../keymap"
import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { useSDK } from "../context/sdk"
import { useTuiI18n, type TuiI18n } from "../context/i18n"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { createIMClient } from "./im-client"
import { useOptionalRoute } from "../context/route"
import { useTuiPaths } from "../context/runtime"
import { createStore } from "solid-js/store"
import { DialogPrompt } from "../ui/dialog-prompt"
import { TaskHumanClient } from "@deepagent-code/core/session/task-human-client"

type Kind = AttentionItem["kind"] | undefined
type View = "all" | "unseen"
type Command =
  | { kind: "task"; item: AttentionItem; body: TaskHumanControlInput; directory: string; projectID: string }
  | {
      kind: "goal"
      item: AttentionItem
      action: "pause" | "resume" | "stop"
      directory: string
      body: { sessionID: string; goalId: string; expectedRevision: number; requestID: string }
    }
const pendingCommands = new WeakMap<
  object,
  {
    owner: ReturnType<typeof useSDK>
    url: string
    directory?: string
    headers: string
    signal?: AbortSignal | null
    transport?: TaskHumanClient.Transport
    command: Command
  }
>()
const taskActions = ["request_close", "resolve_failed", "resolve_closed"] as const
const goalActions = ["pause", "resume", "stop", "edit"] as const
type Screen =
  | { type: "list" }
  | { type: "detail"; item: AttentionItem }
  | { type: "terminate"; item: AttentionItem }
  | { type: "reason"; item: AttentionItem; action: string }
  | { type: "confirm"; item: AttentionItem; action: string; reason: string }
  | {
      type: "session"
      item: AttentionItem
      session: SessionV2Info
      messages: SessionMessagesResponse
      cursor?: string
    }
  | { type: "message"; message: SessionMessage; parent: Extract<Screen, { type: "session" }> }

class AttentionRequestError extends Error {
  constructor(readonly status: number) {
    super("Attention request failed")
  }
}

function resultData<T>(result: { data?: T; error?: unknown; response?: Response }): T {
  if (result.error || !result.data) throw new AttentionRequestError(result.response?.status ?? 0)
  return result.data
}

export function attentionCommand(dialog: DialogContext, i18n: TuiI18n) {
  return {
    name: "attention.list",
    title: i18n.t("tui.attention.title"),
    slashName: "attention",
    run: () => dialog.replace(() => <DialogAttention />),
    category: i18n.t("tui.category.system"),
  }
}

export function DialogAttention() {
  const sdk = useSDK()
  const dialog = useDialog()
  const route = useOptionalRoute()
  const paths = useTuiPaths()
  const i18n = useTuiI18n()
  const { theme } = useTheme()
  const client = sdk.client
  const url = sdk.url
  const directory = sdk.directory
  const source = createIMClient(sdk)
  const scope = source.scope()
  const transport = sdk.taskControl
  const abort = new AbortController()
  const [capability, setCapability] = createSignal<AttentionCapability>()
  const [list, setList] = createSignal<AttentionList>()
  const [kind, setKind] = createSignal<Kind>()
  const [view, setView] = createSignal<View>("unseen")
  const [cursors, setCursors] = createSignal<(string | undefined)[]>([undefined])
  const [page, setPage] = createSignal(0)
  const [screen, setScreen] = createSignal<Screen>({ type: "list" })
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal("")
  const [stale, setStale] = createSignal(false)
  const [notice, setNotice] = createSignal("")
  const [now, setNow] = createSignal(Date.now())
  const [selection, setSelection] = createSignal<string>()
  const [mutation, setMutation] = createStore<{ command?: Command; error?: "changed" | "rejected" | "unknown" }>({})
  let transcript: ScrollBoxRenderable | undefined
  let disposed = false
  const scopeCurrent = () =>
    sdk.client === client &&
    sdk.url === url &&
    sdk.directory === directory &&
    sdk.taskControl === transport &&
    source.scope() === scope &&
    !scope.signal?.aborted
  const current = () => !disposed && !abort.signal.aborted && scopeCurrent()
  const pending = pendingCommands.get(client)
  // Each dialog constructs its own IM reader scope object. Reopening the same
  // SDK owner may retain an unknown command, while every credential/route/port
  // change must discard that view without sending a replacement command.
  if (
    pending?.owner === sdk &&
    pending.url === url &&
    pending.directory === directory &&
    pending.signal === scope.signal &&
    pending.headers === JSON.stringify([...scope.headers.entries()]) &&
    pending.transport === transport &&
    !scope.signal?.aborted
  )
    setMutation({ command: pending.command, error: "unknown" })
  const clock = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => {
    disposed = true
    abort.abort()
    clearInterval(clock)
  })
  createEffect(() => {
    if (current()) return
    abort.abort()
    setList(undefined)
    setScreen({ type: "list" })
    setStale(true)
    setFailure(i18n.t("tui.attention.approvalChanged"))
  })
  createEffect(() => {
    if (screen().type !== "reason" && current()) dialog.setSize("large")
  })

  async function run(work: () => Promise<void>) {
    if (busy() || !current()) return
    setBusy(true)
    setFailure("")
    setNotice("")
    await work()
      .catch((error: unknown) => {
        if (!current()) return
        const conflict = error instanceof AttentionRequestError && error.status === 409
        if (conflict) setStale(true)
        setFailure(i18n.t(conflict ? "tui.attention.stale" : "tui.attention.error"))
      })
      .finally(() => {
        if (disposed) return
        setBusy(false)
        if (current()) return
        abort.abort()
        setList(undefined)
        setScreen({ type: "list" })
        setStale(true)
        setFailure(i18n.t("tui.attention.approvalChanged"))
      })
  }

  async function load(cursor?: string, index = 0, nextKind = kind(), nextView = view()) {
    const enabled = resultData(await client.v2.attention.capability(undefined, { signal: abort.signal }))
    if (!current()) return
    if (nextKind !== kind() || nextView !== view()) setSelection(undefined)
    setCapability(enabled)
    if (!enabled.enabled) {
      setList(undefined)
      setScreen({ type: "list" })
      return
    }
    const rows = resultData(
      await client.v2.attention.list({ kind: nextKind, view: nextView, cursor, limit: "20" }, { signal: abort.signal }),
    )
    if (!current()) return
    if (rows.nextCursor && [...cursors().slice(0, index), cursor].includes(rows.nextCursor))
      throw new AttentionRequestError(400)
    setKind(nextKind)
    setView(nextView)
    setPage(index)
    setCursors((previous) => [...previous.slice(0, index), cursor])
    setList(rows)
    setStale(false)
    setScreen({ type: "list" })
  }

  async function detail(itemID: string) {
    const item = resultData(await readItem(itemID, abort.signal)).data
    if (!current()) return
    setSelection(`item:${itemID}`)
    setStale(false)
    setScreen({ type: "detail", item })
  }

  async function readItem(itemID: string, signal: AbortSignal) {
    const item = resultData(await client.v2.attention.get({ itemID }, { signal })).data
    if (!sdk.taskControl || item.kind !== "task") return { data: { data: item } }
    const current = await sdk.taskControl.get({ itemID }, signal)
    return { data: { data: { ...current, allowedActions: current.allowedActions?.slice() } } }
  }

  async function seen(item: AttentionItem) {
    if (stale() || item.seen) return
    const updated = resultData(
      await client.v2.attention.seen({ itemID: item.id, revision: item.revision }, { signal: abort.signal }),
    ).data
    if (!current()) return
    // Viewing is only acknowledgement. Recovery state remains server-owned.
    const observed =
      sdk.taskControl && updated.kind === "task" ? resultData(await readItem(updated.id, abort.signal)).data : updated
    if (!current()) return
    setScreen({ type: "detail", item: observed })
    setList(undefined)
  }

  async function approve(item: AttentionItem, action: "continue_once" | "terminate") {
    if (!current() || !approvalAllowed(item, action, Date.now())) return
    const captured = {
      ...item,
      session: { ...item.session },
      source: { ...item.source },
      allowedActions: item.allowedActions?.slice(),
    }
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)])
    const fresh = resultData(await client.v2.attention.get({ itemID: item.id }, { signal })).data
    if (!current()) return
    if (!sameApproval(captured, fresh) || !approvalAllowed(fresh, action, Date.now())) {
      setStale(true)
      setScreen({ type: "detail", item: { ...item, allowedActions: [] } })
      setFailure(i18n.t("tui.attention.approvalChanged"))
      return
    }
    const result = await client.v2.session.permission.reply(
      {
        sessionID: captured.session.id,
        requestID: captured.source.permissionRequestID!,
        reply: action === "continue_once" ? "once" : "reject",
      },
      { signal },
    )
    if (!current()) return
    if (result.error || result.response?.status !== 204) throw new AttentionRequestError(result.response?.status ?? 0)
    setScreen({ type: "detail", item: { ...item, allowedActions: [] } })
    setNotice(i18n.t("tui.attention.actionSubmitted"))
    // A successful reply is not a locally synthesized outcome. Reload the original item and
    // leave only its read context if the pending approval has disappeared.
    const updated = await client.v2.attention.get({ itemID: item.id }, { signal }).catch(() => undefined)
    if (!current()) return
    if (updated?.data) setScreen({ type: "detail", item: updated.data.data })
    setList(undefined)
  }

  async function act(item: AttentionItem, action: string, reason = "", retry = false) {
    if (!current() || (!retry && mutation.command)) return
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)])
    setMutation("error", undefined)
    const fail = (error: "changed" | "rejected" | "unknown") => {
      if (current()) setMutation("error", error)
    }
    const command = retry
      ? mutation.command
      : await (async (): Promise<Command | undefined> => {
          const fresh = await readItem(item.id, signal).catch(() => undefined)
          if (
            !current() ||
            !fresh?.data ||
            !sameSource(item, fresh.data.data) ||
            !advertises(fresh.data.data, action)
          ) {
            fail("changed")
            return
          }
          const captured = snapshotItem(fresh.data.data)
          if (captured.kind === "task" && captured.source.task && action.startsWith("task_")) {
            const selected = taskActions.find((value) => `task_${value}` === action)
            if (!selected || !validReason(reason)) {
              fail("rejected")
              return
            }
            const task = captured.source.task
            const parent = await client.v2.session
              .get({ sessionID: task.parentSessionID }, { signal })
              .catch(() => undefined)
            if (
              !current() ||
              !parent?.data ||
              parent.data.data.id !== task.parentSessionID ||
              parent.data.data.location.workspaceID
            ) {
              fail("changed")
              return
            }
            return {
              kind: "task",
              item: captured,
              directory: parent.data.data.location.directory,
              projectID: parent.data.data.projectID,
              body: {
                runID: task.runID,
                parentSessionID: task.parentSessionID,
                childSessionID: task.childSessionID,
                generation: task.generation,
                expectedVersion: task.version,
                itemID: captured.id,
                itemRevision: captured.revision,
                requestID: crypto.randomUUID(),
                action: selected,
                reason,
              },
            }
          }
          if (captured.kind !== "goal" || !captured.source.goal) {
            fail("changed")
            return
          }
          const goal = captured.source.goal
          const observed = await client.deepagent
            .goalStatus({ sessionID: captured.session.id, directory: captured.session.directory }, { signal })
            .catch(() => undefined)
          if (
            !current() ||
            !observed?.data?.goal ||
            observed.data.goal.goalId !== goal.goalID ||
            observed.data.goal.revision !== goal.controlRevision ||
            observed.data.goal.planDocId !== goal.planDocID
          ) {
            fail("changed")
            return
          }
          if (action === "goal_edit") {
            const { openGoalPlan } = await import("./dialog-goal-plan")
            if (!current()) return
            // The original SDK provider remains the owner while its child dialog changes.
            // Do not use this soon-to-be-disposed view as the plan relay's authority.
            await openGoalPlan({
              sdk,
              sessionID: captured.session.id,
              directory: captured.session.directory,
              stateDirectory: paths.state,
              dialog,
              current: scopeCurrent,
              text: (key) => i18n.t(`tui.goal.plan.${key}` as Parameters<typeof i18n.t>[0]),
            })
            if (scopeCurrent()) dialog.replace(() => <DialogAttention />)
            return
          }
          const selected = ["pause", "resume", "stop"].find((value) => `goal_${value}` === action)
          if (selected !== "pause" && selected !== "resume" && selected !== "stop") {
            fail("changed")
            return
          }
          return {
            kind: "goal",
            item: captured,
            action: selected,
            directory: captured.session.directory,
            body: {
              sessionID: captured.session.id,
              goalId: goal.goalID,
              expectedRevision: goal.controlRevision,
              requestID: crypto.randomUUID(),
            },
          }
        })().catch(() => {
          fail("rejected")
          return undefined
        })
    if (!command || !current()) return
    pendingCommands.set(client, {
      owner: sdk,
      url,
      directory,
      headers: JSON.stringify([...scope.headers.entries()]),
      signal: scope.signal,
      transport,
      command,
    })
    setMutation("command", command)
    try {
      if (command.kind === "task") {
        const release = sdk.protectTaskControl()
        const result = await (
          sdk.taskControl
            ? sdk.taskControl
              .control({ ...command.body }, signal)
                .then((data) => ({ data, rejected: false }))
                .catch((error: unknown) => ({
                  data: undefined,
                  rejected: error instanceof TaskHumanClient.RequestError && !error.unknown,
                }))
            : client.v2.attention
                .taskControl({ directory: command.directory, taskHumanControlInput: command.body }, { signal })
                .then((reply) => ({
                  data: reply.data,
                  rejected: [400, 401, 403, 409, 429].includes(reply.response?.status ?? 0),
                }))
                .catch(() => ({ data: undefined, rejected: false }))
        ).finally(release)
        if (!current()) return
        if (!result?.data) {
          if (result.rejected) {
            pendingCommands.delete(client)
            setMutation("command", undefined)
            fail("rejected")
            return
          }
          fail("unknown")
          return
        }
        const receipt = result.data.receipt
        if (
          !sameTaskRequest(receipt.request, command.body) ||
          receipt.contract !== "task-human-control-v1" ||
          receipt.authority.scope !== "implicit-local" ||
          receipt.authority.directory !== command.directory ||
          receipt.authority.projectID !== command.projectID ||
          receipt.recordedChildSessionID !== command.item.source.task?.recordedChildSessionID
        ) {
          fail("unknown")
          return
        }
      }
      if (command.kind === "goal") {
        const input = { ...command.body, directory: command.directory }
        const result = await (
          command.action === "pause"
            ? client.deepagent.goalPause(input, { signal })
            : command.action === "resume"
              ? client.deepagent.goalResume(input, { signal })
              : client.deepagent.goalStop(input, { signal })
        ).catch(() => undefined)
        if (!current()) return
        if (!result?.data) {
          if ([400, 401, 403, 409, 429].includes(result?.response?.status ?? 0)) {
            pendingCommands.delete(client)
            setMutation("command", undefined)
            fail("rejected")
            return
          }
          fail("unknown")
          return
        }
        const acknowledged = await goalReceipt(result.data, command)
        if (!current()) return
        if (!acknowledged) {
          fail("unknown")
          return
        }
      }
      pendingCommands.delete(client)
      setMutation({ command: undefined, error: undefined })
      setNotice(i18n.t("tui.attention.actionSubmitted"))
      await detail(item.id).catch(() => {
        if (!current()) return
        setScreen({ type: "detail", item })
        setFailure(i18n.t("tui.attention.error"))
      })
    } catch {
      fail("unknown")
    } finally {
      if (current() && mutation.error) setScreen({ type: "detail", item })
    }
  }

  async function session(item: AttentionItem, cursor?: string, parent = false, controls = false) {
    const fresh = resultData(await client.v2.attention.get({ itemID: item.id }, { signal: abort.signal })).data
    if (!current()) return
    if (!sameSource(item, fresh)) throw new AttentionRequestError(409)
    const sessionID = parent ? fresh.source.task?.parentSessionID : fresh.session.id
    if (!sessionID) throw new AttentionRequestError(409)
    const target = resultData(await client.v2.session.get({ sessionID }, { signal: abort.signal })).data
    if (!current()) return
    // Session placement, not the current TUI directory, is authoritative. Do not
    // enter the editable route until all project/config/prompt contexts can switch atomically.
    if (
      target.id !== sessionID ||
      (!parent && target.projectID !== fresh.session.projectID) ||
      target.location.workspaceID ||
      (!parent && target.location.directory !== fresh.session.directory)
    )
      throw new AttentionRequestError(409)
    if (controls) {
      if (!route || target.location.directory !== directory) throw new AttentionRequestError(409)
      route.navigate({ type: "session", sessionID: target.id })
      dialog.clear()
      return
    }
    const messages = resultData(
      await sdk.forDirectory(target.location.directory).v2.session.messages(
        {
          sessionID: target.id,
          limit: 20,
          order: "asc",
          cursor,
        },
        { signal: abort.signal },
      ),
    )
    if (!current()) return
    if (messages.data.length && cursor && (messages.cursor.next === cursor || messages.cursor.previous === cursor))
      throw new AttentionRequestError(400)
    setScreen({ type: "session", item, session: target, messages, cursor })
  }

  const label = (item: AttentionItem) => i18n.t(`tui.attention.kind.${item.kind}`)
  const stateLabel = (item: AttentionItem) => i18n.t(`tui.attention.state.${item.state}`)
  const control = (title: string, action: () => void, disabled = false): DialogSelectOption<string> => ({
    title,
    value: `action:${title}`,
    onSelect: action,
    category: i18n.t("tui.attention.actions"),
    disabled,
  })
  const options = (current: Screen): DialogSelectOption<string>[] => {
    if (current.type === "confirm")
      return [
        control(i18n.t("tui.attention.back"), () => setScreen({ type: "detail", item: current.item })),
        control(
          i18n.t("tui.attention.control.confirm"),
          () => void run(() => act(current.item, current.action, current.reason)),
          !!mutation.command,
        ),
      ]
    if (current.type === "reason") return []
    if (current.type === "terminate")
      return [
        control(i18n.t("tui.attention.back"), () => setScreen({ type: "detail", item: current.item })),
        control(
          i18n.t("tui.attention.confirmTerminate"),
          () => void run(() => approve(current.item, "terminate")),
          stale() || !approvalAllowed(current.item, "terminate", now()),
        ),
      ]
    if (current.type === "message") return [control(i18n.t("tui.attention.back"), () => setScreen(current.parent))]
    if (current.type === "session")
      return [
        control(i18n.t("tui.attention.back"), () => setScreen({ type: "detail", item: current.item })),
        control(i18n.t("tui.attention.refresh"), () => void run(() => session(current.item, current.cursor))),
        control(
          i18n.t("tui.attention.previous"),
          () => void run(() => session(current.item, current.messages.cursor.previous)),
          !current.messages.cursor.previous,
        ),
        control(
          i18n.t("tui.attention.next"),
          () => void run(() => session(current.item, current.messages.cursor.next)),
          !current.messages.cursor.next,
        ),
        ...current.messages.data.map((message) => ({
          title: messageText(message).replace(/\s+/g, " ").slice(0, 100) || message.type,
          value: `message:${message.id}`,
          onSelect: () => setScreen({ type: "message", message, parent: current }),
          category: message.type,
          description: message.id,
        })),
      ]
    if (current.type === "detail")
      return [
        ...[...taskActions.map((action) => `task_${action}`), ...goalActions.map((action) => `goal_${action}`)]
          .filter((action) => advertises(current.item, action))
          .map((action) =>
            control(
              i18n.t(`tui.attention.action.${action}` as Parameters<typeof i18n.t>[0]),
              () =>
                setScreen(
                  action.startsWith("task_")
                    ? { type: "reason", item: current.item, action }
                    : { type: "confirm", item: current.item, action, reason: "" },
                ),
              stale() || !!mutation.command,
            ),
          ),
        ...(mutation.command && mutation.error === "unknown"
          ? [
              control(
                i18n.t("tui.attention.control.retry"),
                () => void run(() => act(mutation.command!.item, "", "", true)),
              ),
            ]
          : []),
        ...(current.item.allowedActions?.includes("continue_once")
          ? [
              control(
                i18n.t("tui.attention.continueOnce"),
                () => void run(() => approve(current.item, "continue_once")),
                stale() || !approvalAllowed(current.item, "continue_once", now()),
              ),
            ]
          : []),
        ...(current.item.allowedActions?.includes("terminate")
          ? [
              control(
                i18n.t("tui.attention.terminate"),
                () => setScreen({ type: "terminate", item: current.item }),
                stale() || !approvalAllowed(current.item, "terminate", now()),
              ),
            ]
          : []),
        control(i18n.t("tui.attention.back"), () => void run(() => load(cursors()[page()], page()))),
        control(i18n.t("tui.attention.refresh"), () => void run(() => detail(current.item.id))),
        control(
          i18n.t("tui.attention.markSeen"),
          () => void run(() => seen(current.item)),
          current.item.seen || stale(),
        ),
        control(i18n.t("tui.attention.session"), () => void run(() => session(current.item)), stale()),
        ...(current.item.source.task
          ? [
              control(
                i18n.t("tui.attention.source.openParent"),
                () => void run(() => session(current.item, undefined, true)),
                stale(),
              ),
            ]
          : []),
        ...(current.item.kind === "goal" && route
          ? [
              control(
                i18n.t("tui.attention.source.controls"),
                () => void run(() => session(current.item, undefined, false, true)),
                stale() || current.item.session.directory !== directory,
              ),
            ]
          : []),
      ]
    return [
      ...(list()?.data ?? []).map((item) => ({
        title: item.session.title,
        value: `item:${item.id}`,
        onSelect: () => void run(() => detail(item.id)),
        category: label(item),
        description: `${stateLabel(item)} · ${i18n.t(item.seen ? "tui.attention.seen" : "tui.attention.unseen")} · ${item.session.directory}`,
      })),
      ...(mutation.command && mutation.error === "unknown"
        ? [
            {
              ...control(
                i18n.t("tui.attention.control.retry"),
                () => void run(() => act(mutation.command!.item, "", "", true)),
              ),
              description: mutation.command.item.session.title,
            },
          ]
        : []),
      control(i18n.t("tui.attention.refresh"), () => void run(() => load())),
      control(
        i18n.t("tui.attention.filter", { value: i18n.t(`tui.attention.${view()}`) }),
        () => void run(() => load(undefined, 0, kind(), view() === "unseen" ? "all" : "unseen")),
        !capability()?.enabled,
      ),
      control(
        i18n.t("tui.attention.type", {
          value: kind() ? i18n.t(`tui.attention.kind.${kind()!}`) : i18n.t("tui.attention.allTypes"),
        }),
        () =>
          void run(() =>
            load(
              undefined,
              0,
              kind() === undefined
                ? "activity_failed"
                : kind() === "activity_failed"
                  ? "execution_recovery"
                  : kind() === "execution_recovery"
                    ? "no_progress"
                    : kind() === "no_progress"
                      ? "task"
                      : kind() === "task"
                        ? "goal"
                        : undefined,
            ),
          ),
        !capability()?.enabled,
      ),
      control(
        i18n.t("tui.attention.previous"),
        () => void run(() => load(cursors()[page() - 1], page() - 1)),
        page() === 0,
      ),
      control(
        i18n.t("tui.attention.next"),
        () => void run(() => load(list()?.nextCursor, page() + 1)),
        !list()?.nextCursor,
      ),
    ]
  }

  const description = (current: Screen) => {
    if (current.type === "confirm")
      return [
        current.item.session.title,
        i18n.t(`tui.attention.action.${current.action}` as Parameters<typeof i18n.t>[0]),
        current.reason,
        i18n.t(current.item.kind === "task" ? "tui.attention.control.taskHelp" : "tui.attention.control.goalHelp"),
      ]
        .filter(Boolean)
        .join("\n")
    if (current.type === "reason") return ""
    if (current.type === "message") return messageText(current.message)
    if (current.type === "session")
      return [
        current.session.title,
        current.session.location.directory,
        current.session.id,
        i18n.t("tui.attention.readonlySession"),
        current.messages.data.length ? "" : i18n.t("tui.attention.noMessages"),
      ]
        .filter(Boolean)
        .join("\n")
    if (current.type === "detail" || current.type === "terminate")
      return [
        current.item.session.title,
        `${label(current.item)} · ${stateLabel(current.item)} · ${i18n.t(current.item.seen ? "tui.attention.seen" : "tui.attention.unseen")}`,
        current.item.session.directory,
        ...(current.item.kind === "no_progress"
          ? [
              i18n.t("tui.attention.approvalExpires", {
                time: current.item.source.expiresAt ? new Date(current.item.source.expiresAt).toLocaleString() : "",
              }),
            ]
          : []),
        `${current.item.session.id} · ${current.item.session.projectID}`,
        ...(current.item.kind === "no_progress" ? [i18n.t("tui.attention.approvalHelp")] : []),
        i18n.t(`tui.attention.reason.${current.item.reasonCode}`),
        ...(current.item.source.task
          ? [
              `${i18n.t("tui.attention.source.parent")}: ${current.item.source.task.parentSessionID}`,
              `${i18n.t("tui.attention.source.child")}: ${current.item.source.task.childSessionID ?? i18n.t("tui.attention.source.childUnavailable")}`,
              `${i18n.t("tui.attention.source.pendingEffects")}: ${current.item.source.task.pendingProviders + current.item.source.task.pendingProviderAttempts + current.item.source.task.pendingToolEffects}`,
              `${i18n.t("tui.attention.source.claim")}: ${i18n.t(current.item.source.task.hasExecutionClaim ? "tui.attention.source.yes" : "tui.attention.source.no")}`,
              current.item.source.task.controlState === "close_requested"
                ? i18n.t("tui.attention.source.closeIntent")
                : "",
            ]
          : []),
        ...(current.item.source.goal
          ? [
              `${i18n.t("tui.attention.source.goal")}: ${current.item.source.goal.goalID}`,
              `${i18n.t("tui.attention.source.planRevision")}: ${current.item.source.goal.planRevision}`,
              `${i18n.t("tui.attention.source.pendingRebase")}: ${i18n.t(current.item.source.goal.pendingRebase ? "tui.attention.source.yes" : "tui.attention.source.no")}`,
              `${i18n.t("tui.attention.source.pendingPermits")}: ${current.item.source.goal.pendingPermits}`,
              `${i18n.t("tui.attention.source.unknownPermits")}: ${current.item.source.goal.unknownPermits}`,
              i18n.t("tui.attention.source.controlsHelp"),
            ]
          : []),
        current.item.source.activityID ?? "",
        current.type === "terminate" ? i18n.t("tui.attention.confirmTerminate") : "",
        i18n.t("tui.attention.seenHint"),
      ]
        .filter(Boolean)
        .join("\n")
    if (capability() && !capability()!.enabled) return i18n.t(`tui.attention.disabled.${capability()!.reason}`)
    return [
      i18n.t("tui.attention.summary", { page: page() + 1, unseen: list()?.unseenCount ?? 0 }),
      i18n.t("tui.attention.seenHint"),
      list() && list()!.data.length === 0 ? i18n.t("tui.attention.empty") : "",
    ]
      .filter(Boolean)
      .join("\n")
  }

  useBindings(() => {
    const current = screen()
    return {
      bindings:
        current.type === "message" || current.type === "detail" || current.type === "terminate"
          ? [
              {
                key: "ctrl+d",
                desc: i18n.t("tui.attention.scrollDown"),
                group: "Attention",
                cmd: () => transcript?.scrollBy(current.type === "message" ? 6 : 3),
              },
              {
                key: "ctrl+u",
                desc: i18n.t("tui.attention.scrollUp"),
                group: "Attention",
                cmd: () => transcript?.scrollBy(current.type === "message" ? -6 : -3),
              },
            ]
          : [],
    }
  })
  onMount(() => {
    dialog.setSize("large")
    void run(() => load())
  })
  return (
    <box>
      <Show when={screen()} keyed>
        {(current) => (
          <box>
            <Show
              when={current.type === "reason" ? current : undefined}
              fallback={
                <>
                  <box paddingLeft={4} paddingRight={4} paddingBottom={1}>
                    <Show
                      when={current.type === "message" || current.type === "detail" || current.type === "terminate"}
                      fallback={<text fg={theme.textMuted}>{description(current)}</text>}
                    >
                      <scrollbox
                        ref={(value) => {
                          transcript = value
                        }}
                        height={current.type === "message" ? 10 : 4}
                      >
                        <text fg={theme.text}>{description(current)}</text>
                      </scrollbox>
                      <text fg={theme.textMuted}>{i18n.t("tui.attention.scrollHint")}</text>
                    </Show>
                    <Show when={busy()}>
                      <text fg={theme.textMuted}>{i18n.t("tui.attention.loading")}</text>
                    </Show>
                    <Show when={failure()}>
                      <text fg={theme.error}>{failure()}</text>
                    </Show>
                    <Show when={notice()}>
                      <text fg={theme.text}>{notice()}</text>
                    </Show>
                    <Show when={mutation.error}>
                      {(error) => <text fg={theme.error}>{i18n.t(`tui.attention.control.${error()}`)}</text>}
                    </Show>
                  </box>
                  <DialogSelect
                    title={i18n.t(
                      current.type === "session" || current.type === "message"
                        ? "tui.attention.session"
                        : "tui.attention.title",
                    )}
                    locked={busy()}
                    current={current.type === "list" ? selection() : undefined}
                    onMove={(option) => {
                      if (current.type === "list" && option.value.startsWith("item:")) setSelection(option.value)
                    }}
                    options={options(current)}
                  />
                </>
              }
            >
              {(reason) => (
                <DialogPrompt
                  title={i18n.t("tui.attention.control.reason")}
                  description={
                    <box gap={1}>
                      <text>{i18n.t("tui.attention.control.taskHelp")}</text>
                      <Show when={mutation.error}>
                        {(error) => <text fg={theme.warning}>{i18n.t(`tui.attention.control.${error()}`)}</text>}
                      </Show>
                    </box>
                  }
                  onCancel={() => setScreen({ type: "detail", item: reason().item })}
                  onConfirm={(value) => {
                    if (!validReason(value)) {
                      setMutation("error", "rejected")
                      return
                    }
                    setScreen({ type: "confirm", item: reason().item, action: reason().action, reason: value })
                  }}
                />
              )}
            </Show>
          </box>
        )}
      </Show>
    </box>
  )
}

function approvalAllowed(item: AttentionItem, action: "continue_once" | "terminate", now: number) {
  return (
    item.kind === "no_progress" &&
    item.state === "needs_human" &&
    item.reasonCode === "no_progress" &&
    !!item.source.activityID &&
    !!item.source.permissionRequestID &&
    typeof item.source.expiresAt === "number" &&
    Number.isFinite(item.source.expiresAt) &&
    item.source.expiresAt > now &&
    item.allowedActions?.includes(action) === true
  )
}

function sameApproval(before: AttentionItem, after: AttentionItem) {
  return (
    JSON.stringify([
      before.id,
      before.revision,
      before.kind,
      before.state,
      before.reasonCode,
      before.session,
      before.source,
      before.allowedActions,
    ]) ===
    JSON.stringify([
      after.id,
      after.revision,
      after.kind,
      after.state,
      after.reasonCode,
      after.session,
      after.source,
      after.allowedActions,
    ])
  )
}

function sameSource(before: AttentionItem, after: AttentionItem) {
  return (
    JSON.stringify([before.id, before.revision, before.kind, before.session, before.source]) ===
    JSON.stringify([after.id, after.revision, after.kind, after.session, after.source])
  )
}

function advertises(item: AttentionItem, action: string) {
  return item.allowedActions?.some((value) => value === action) === true
}
function validReason(reason: string) {
  return (
    reason.trim().length > 0 &&
    reason.isWellFormed() &&
    new TextEncoder().encode(reason).length <= 2048 &&
    !reason.includes("\u0000")
  )
}
function snapshotItem(item: AttentionItem): AttentionItem {
  return {
    ...item,
    session: { ...item.session },
    source: {
      ...item.source,
      ...(item.source.task ? { task: { ...item.source.task } } : {}),
      ...(item.source.goal ? { goal: { ...item.source.goal } } : {}),
    },
    allowedActions: item.allowedActions?.slice(),
  }
}
function sameTaskRequest(a: TaskHumanControlInput, b: TaskHumanControlInput) {
  return (
    JSON.stringify([
      a.runID,
      a.parentSessionID,
      a.childSessionID,
      a.generation,
      a.expectedVersion,
      a.itemID,
      a.itemRevision,
      a.requestID,
      a.action,
      a.reason,
    ]) ===
    JSON.stringify([
      b.runID,
      b.parentSessionID,
      b.childSessionID,
      b.generation,
      b.expectedVersion,
      b.itemID,
      b.itemRevision,
      b.requestID,
      b.action,
      b.reason,
    ])
  )
}
async function goalReceipt(value: DeepagentGoalPauseResponses[200], command: Extract<Command, { kind: "goal" }>) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([command.body.sessionID, command.body.requestID])),
  )
  return (
    value.goalId === command.body.goalId &&
    value.planDocId === command.item.source.goal?.planDocID &&
    Number.isSafeInteger(value.revision) &&
    value.revision > command.body.expectedRevision &&
    value.requestedPhase === ({ pause: "paused", resume: "running", stop: "stopped" } as const)[command.action] &&
    value.receiptID ===
      `goalcmd_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
  )
}

function messageText(message: SessionMessage) {
  if ("text" in message) return message.text
  if (message.type === "assistant")
    return message.content.map((part) => ("text" in part ? part.text : `[${part.name}]`)).join("\n")
  if (message.type === "shell") return `${message.command}\n${message.output}`
  if (message.type === "compaction") return message.summary
  if (message.type === "agent-switched") return message.agent
  return `${message.model.providerID}/${message.model.id}`
}
