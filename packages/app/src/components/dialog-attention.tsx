import { batch, createEffect, createMemo, For, onCleanup, Show, untrack } from "solid-js"
import { createStore, reconcile, unwrap } from "solid-js/store"
import type {
  AttentionCapability,
  AttentionItem,
  AttentionList,
  TaskHumanControlInput,
  DeepagentGoalPauseResponses,
} from "@deepagent-code/sdk/client"
import { Button } from "@deepagent-code/ui/button"
import { Dialog } from "@deepagent-code/ui/dialog"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useDialog } from "@deepagent-code/ui/context/dialog"

type Props = { onOpenSession: (session: AttentionItem["session"]) => void }
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
  { scope: string; url: string; command: Command; username?: string; password?: string; bearer?: string }
>()
const taskActions = ["request_close", "resolve_failed", "resolve_closed"] as const
const goalActions = ["pause", "resume", "stop", "edit"] as const
const bookmarks = new WeakMap<
  object,
  {
    scope: string
    url: string
    kind: AttentionItem["kind"] | "all"
    view: "all" | "unseen"
    pages: number
    selectedID?: string
    scrollTop: number
    username?: string
    password?: string
    bearer?: string
  }
>()

export function DialogAttention(props: Props) {
  const language = useLanguage()
  const dialog = useDialog()
  return (
    <Dialog title={language.t("attention.title")} description={language.t("attention.description")} size="large">
      <AttentionInbox onOpenSession={props.onOpenSession} dialog={dialog} />
    </Dialog>
  )
}

// Export the rendered inbox for DOM verification with only the service boundary replaced.
export function AttentionInbox(props: Props & { dialog?: ReturnType<typeof useDialog> }) {
  const sdk = useServerSDK()
  const server = useServer()
  const language = useLanguage()
  const mountedServer = server.key
  const client = sdk.client
  const scope = sdk.scope
  const url = sdk.url
  const connection = server.current
  const http = connection?.http && { ...connection.http }
  const remembered = bookmarks.get(client)
  const bookmark =
    remembered &&
    remembered.scope === scope &&
    remembered.url === url &&
    remembered.username === http?.username &&
    remembered.password === http?.password &&
    remembered.bearer === http?.bearer
      ? remembered
      : undefined
  const abort = new AbortController()
  const [state, setState] = createStore<{
    kind: AttentionItem["kind"] | "all"
    view: "all" | "unseen"
    capability?: AttentionCapability
    list?: AttentionList
    loading: boolean
    error: boolean
    notice?: "changed" | "actionError" | "approvalChanged" | "actionSubmitted"
    selected?: AttentionItem
    detailLoading: boolean
    marking?: string
    acting?: string
    confirming?: string
    now: number
    switched: boolean
    reason: string
    command?: Command
    controlError?: "changed" | "rejected" | "unknown"
    controlConfirm?: string
  }>({
    kind: bookmark?.kind ?? "all",
    view: bookmark?.view ?? "all",
    loading: false,
    error: false,
    detailLoading: false,
    switched: false,
    now: Date.now(),
    reason: "",
  })
  let epoch = 0
  let request = 0
  let detailRequest = 0
  let filterEpoch = 0
  let pages = bookmark?.pages ?? 1
  let restoring = true
  let disposed = false
  let invalidated = false
  let section: HTMLElement | undefined
  let scrollRestored = false

  const ownerCurrent = () =>
    server.key === mountedServer &&
    sdk.client === client &&
    sdk.scope === scope &&
    sdk.url === url &&
    (!connection || connection.http.url === url) &&
    server.current === connection &&
    connection?.http.username === http?.username &&
    connection?.http.password === http?.password &&
    connection?.http.bearer === http?.bearer
  const current = (generation: number) => !disposed && !invalidated && generation === epoch && ownerCurrent()
  const pending = pendingCommands.get(client)
  if (
    pending &&
    pending.scope === scope &&
    pending.url === url &&
    pending.username === http?.username &&
    pending.password === http?.password &&
    pending.bearer === http?.bearer
  )
    setState({
      command: pending.command,
      controlError: "unknown",
      reason: pending.command.kind === "task" ? pending.command.body.reason : "",
    })
  const date = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value)
      ? new Date(value).toLocaleString(language.intl())
      : language.t("attention.timeUnknown")
  // Selection is an independent snapshot. A list row adopted here would be
  // mutated by later store merges when the user selects a different source.
  const select = (item?: AttentionItem) =>
    setState("selected", item ? reconcile(structuredClone(unwrap(item))) : undefined)

  async function refresh(append = false) {
    if (!state.capability?.enabled || state.switched) return
    const generation = epoch
    const run = ++request
    const filter = {
      kind: state.kind === "all" ? undefined : (state.kind as AttentionItem["kind"]),
      view: state.view,
      limit: "30",
    }
    const previous = state.list
    setState("loading", true)
    const result = await (async () => {
      // Refresh all loaded pages so a five-second poll does not collapse the user's list.
      const items: AttentionItem[] = append ? [...(previous?.data ?? [])] : []
      let cursor = append ? previous?.nextCursor : undefined
      let latest: AttentionList | undefined
      for (let page = 0; page < (append ? 1 : pages); page++) {
        const result = await sdk.client.v2.attention.list({ ...filter, cursor }, { signal: abort.signal })
        if (!current(generation) || run !== request) return
        if (!result.data) throw new Error("attention_list_unavailable")
        latest = result.data
        items.push(...result.data.data)
        cursor = result.data.nextCursor
        if (!cursor) break
      }
      if (!latest) return
      return { ...latest, data: [...new Map(items.map((item) => [item.id, item])).values()] }
    })().catch(() => undefined)
    if (!current(generation) || run !== request) return
    batch(() => {
      setState("loading", false)
      setState("error", !result)
      if (!result) return
      setState("list", reconcile(result))
      select(
        result.data.find((item) => item.id === (state.selected?.id ?? (restoring ? bookmark?.selectedID : undefined))),
      )
      restoring = false
      if (!scrollRestored) {
        scrollRestored = true
        queueMicrotask(() => {
          if (!current(generation) || run !== request) return
          const target = section?.closest<HTMLElement>('[data-slot="dialog-content"]')
          if (target) target.scrollTop = bookmark?.scrollTop ?? 0
        })
      }
      if (append) pages++
    })
  }

  async function load() {
    const generation = epoch
    setState("loading", true)
    const result = await sdk.client.v2.attention.capability(undefined, { signal: abort.signal }).catch(() => undefined)
    if (!current(generation)) return
    if (result?.response?.status === 404) {
      setState("capability", { enabled: false, scope: "implicit-local", actor: "server", reason: "unsupported_host" })
      setState("loading", false)
      setState("error", false)
      return
    }
    setState("capability", result?.data)
    setState("error", !result?.data)
    setState("loading", false)
    if (result?.data?.enabled) await refresh()
  }

  async function loadDetail(item: AttentionItem, openSession = false, parent = false) {
    const generation = epoch
    const run = ++detailRequest
    const revision = item.revision
    setState("detailLoading", true)
    setState("notice", undefined)
    const result = await sdk.client.v2.attention
      .get({ itemID: item.id }, { signal: abort.signal })
      .catch(() => undefined)
    if (!current(generation) || run !== detailRequest) return
    setState("detailLoading", false)
    if (!result?.data) {
      setState("notice", result?.response?.status === 404 ? "changed" : "actionError")
      if (result?.response?.status === 404) {
        select(undefined)
        void refresh()
      }
      return
    }
    const visible = state.list?.data.find((entry) => entry.id === item.id)
    if (visible && visible.revision !== revision && visible.revision !== result.data.data.revision) {
      select(visible)
      setState("notice", "changed")
      return
    }
    if (openSession) {
      if (!sameSource(item, result.data.data)) {
        select(result.data.data)
        setState("notice", "changed")
        return
      }
      if (parent) {
        const parentID = result.data.data.source.task?.parentSessionID
        if (!parentID) return
        const target = await client.v2.session
          .get({ sessionID: parentID }, { signal: abort.signal })
          .catch(() => undefined)
        if (!current(generation) || run !== detailRequest) return
        if (!target?.data || target.data.data.id !== parentID || target.data.data.location.workspaceID) {
          setState("notice", "actionError")
          return
        }
        props.onOpenSession({
          id: target.data.data.id,
          title: target.data.data.title,
          projectID: target.data.data.projectID,
          directory: target.data.data.location.directory,
          workspaceID: null,
          ...(target.data.data.parentID ? { parentID: target.data.data.parentID } : {}),
        })
        return
      }
      props.onOpenSession(result.data.data.session)
      return
    }
    select(result.data.data)
  }

  async function markSeen(item: AttentionItem) {
    if (state.marking || state.acting) return
    const generation = epoch
    const filters = filterEpoch
    const revision = item.revision
    setState("marking", item.id)
    setState("notice", undefined)
    const result = await sdk.client.v2.attention
      .seen({ itemID: item.id, revision }, { signal: abort.signal })
      .catch(() => undefined)
    if (!current(generation)) return
    setState("marking", undefined)
    if (result?.response?.status === 409 || result?.response?.status === 404) {
      if (filters === filterEpoch && state.selected?.id === item.id) await loadDetail(item)
      if (!current(generation)) return
      if (filters === filterEpoch) setState("notice", "changed")
      await refresh()
      return
    }
    if (!result?.data) {
      if (filters === filterEpoch) setState("notice", "actionError")
      return
    }
    const visible = state.list?.data.find((entry) => entry.id === item.id)
    // A receipt acknowledges the requested revision, not a newer source or another filter's count.
    // Keep the currently rendered snapshot if the subsequent refetch is unavailable.
    if (
      filters !== filterEpoch ||
      !visible ||
      visible.revision !== revision ||
      result.data.data.revision !== revision
    ) {
      if (filters === filterEpoch && visible) setState("notice", "changed")
      await refresh()
      return
    }
    // Invalidate an earlier poll before installing the acknowledged receipt.
    request++
    setState("loading", false)
    setState(
      "list",
      (previous) =>
        previous && {
          ...previous,
          unseenCount:
            typeof previous.unseenCount === "number" && !visible.seen && result.data.data.seen
              ? Math.max(0, previous.unseenCount - 1)
              : previous.unseenCount,
          data: previous.data.flatMap((entry) =>
            entry.id !== item.id ? [entry] : state.view === "unseen" ? [] : [result.data.data],
          ),
        },
    )
    if (state.selected?.id === item.id) select(result.data.data)
    await refresh()
  }

  async function approve(item: AttentionItem, action: "continue_once" | "terminate") {
    if (state.acting || state.marking || !current(epoch) || !approvalAllowed(item, action, Date.now())) return
    const captured = {
      ...item,
      session: { ...item.session },
      source: { ...item.source },
      allowedActions: item.allowedActions?.slice(),
    }
    const generation = epoch
    const filters = filterEpoch
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)])
    setState({ acting: item.id, confirming: undefined, notice: undefined })
    const fresh = await client.v2.attention.get({ itemID: item.id }, { signal }).catch(() => undefined)
    if (!current(generation)) return
    if (filters !== filterEpoch || !state.selected || !sameApproval(captured, state.selected)) {
      setState("acting", undefined)
      return
    }
    if (
      !fresh?.data ||
      !sameApproval(captured, fresh.data.data) ||
      !approvalAllowed(fresh.data.data, action, Date.now())
    ) {
      setState({ acting: undefined, notice: fresh?.response?.status === 503 ? "actionError" : "approvalChanged" })
      return
    }
    // SessionLocation resolves the original session. The current project never substitutes its
    // directory, and this reply is only once/reject for the observed activity approval.
    const result = await client.v2.session.permission
      .reply(
        {
          sessionID: captured.session.id,
          requestID: captured.source.permissionRequestID!,
          reply: action === "continue_once" ? "once" : "reject",
        },
        { signal },
      )
      .catch(() => undefined)
    if (!current(generation)) return
    setState("acting", undefined)
    if (filters !== filterEpoch) return
    if (result?.error || result?.response?.status !== 204) {
      setState("notice", "actionError")
      return
    }
    setState("notice", "actionSubmitted")
    if (state.selected?.id === item.id) select({ ...item, allowedActions: [] })
    await refresh()
  }

  async function control(item: AttentionItem, action: string, retry = false) {
    if (state.acting || state.marking || !current(epoch) || (!retry && state.command)) return
    const generation = epoch
    const filters = filterEpoch
    const reviewedReason = state.reason
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)])
    setState({ acting: item.id, controlError: undefined })
    const fail = (code: "changed" | "rejected" | "unknown") => {
      if (current(generation)) setState("controlError", code)
    }
    const command = retry
      ? state.command
      : await (async (): Promise<Command | undefined> => {
          const fresh = await client.v2.attention.get({ itemID: item.id }, { signal }).catch(() => undefined)
          if (
            !current(generation) ||
            filters !== filterEpoch ||
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
            if (!selected || !validReason(reviewedReason)) {
              fail("rejected")
              return
            }
            const task = captured.source.task
            const parent = await client.v2.session
              .get({ sessionID: task.parentSessionID }, { signal })
              .catch(() => undefined)
            if (
              !current(generation) ||
              filters !== filterEpoch ||
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
                reason: reviewedReason,
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
            !current(generation) ||
            filters !== filterEpoch ||
            !observed?.data?.goal ||
            observed.data.goal.goalId !== goal.goalID ||
            observed.data.goal.revision !== goal.controlRevision ||
            observed.data.goal.planDocId !== goal.planDocID
          ) {
            fail("changed")
            return
          }
          if (action === "goal_edit") {
            if (!props.dialog) {
              fail("rejected")
              return
            }
            const { GoalPlanEditDialog } = await import("@/components/deepagent/goal-plan-edit-dialog")
            if (!current(generation) || filters !== filterEpoch) return
            props.dialog.push(() => (
              <GoalPlanEditDialog
                scope={{
                  server: scope,
                  url,
                  directory: captured.session.directory,
                  sessionID: captured.session.id,
                  goalID: goal.goalID,
                }}
                client={client}
                current={() => current(generation)}
                onClose={() => props.dialog?.close()}
              />
            ))
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
    if (!command || !current(generation) || (!retry && filters !== filterEpoch)) {
      if (current(generation)) setState("acting", undefined)
      return
    }
    // Capture once before dispatch. A failed response never retargets the command.
    pendingCommands.set(client, {
      scope,
      url,
      command,
      username: http?.username,
      password: http?.password,
      bearer: http?.bearer,
    })
    setState({ command, controlConfirm: undefined })
    try {
      if (command.kind === "task") {
        const result = await client.v2.attention
          .taskControl({ directory: command.directory, taskHumanControlInput: command.body }, { signal })
          .catch(() => undefined)
        if (!current(generation)) return
        if (!result?.data) {
          if ([400, 401, 403, 409, 429].includes(result?.response?.status ?? 0)) {
            pendingCommands.delete(client)
            setState("command", undefined)
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
        if (!current(generation)) return
        if (!result?.data) {
          if ([400, 401, 403, 409, 429].includes(result?.response?.status ?? 0)) {
            pendingCommands.delete(client)
            setState("command", undefined)
            fail("rejected")
            return
          }
          fail("unknown")
          return
        }
        const acknowledged = await goalReceipt(result.data, command)
        if (!current(generation)) return
        if (!acknowledged) {
          fail("unknown")
          return
        }
      }
      pendingCommands.delete(client)
      setState({ command: undefined, reason: "", controlError: undefined })
      if (filters === filterEpoch) setState("notice", "actionSubmitted")
      await refresh()
    } catch {
      fail("unknown")
    } finally {
      if (current(generation)) setState("acting", undefined)
    }
  }

  createEffect(() => {
    const changed = invalidated || !ownerCurrent()
    if (changed) invalidated = true
    epoch++
    request++
    detailRequest++
    batch(() => {
      setState("switched", changed)
      setState("capability", undefined)
      setState("list", undefined)
      select(undefined)
      setState("marking", undefined)
      setState("acting", undefined)
      setState("confirming", undefined)
      setState("notice", undefined)
      setState("controlConfirm", undefined)
      setState("error", false)
      setState("loading", false)
      setState("detailLoading", false)
    })
    if (!changed) untrack(() => void load())
    if (changed) abort.abort()
  })

  createEffect(() => {
    state.kind
    state.view
    untrack(() => {
      filterEpoch++
      request++
      detailRequest++
      if (!restoring) pages = 1
      setState("list", undefined)
      select(undefined)
      setState("notice", undefined)
      setState("confirming", undefined)
      setState("detailLoading", false)
      if (state.capability?.enabled) void refresh()
    })
  })

  const poll = setInterval(() => {
    if (!state.loading && !state.marking && !state.acting) void refresh()
  }, 5000)
  const clock = setInterval(() => setState("now", Date.now()), 1000)
  onCleanup(() => {
    if (current(epoch))
      bookmarks.set(client, {
        scope,
        url,
        kind: state.kind,
        view: state.view,
        pages,
        selectedID: state.selected?.id,
        scrollTop: section?.closest<HTMLElement>('[data-slot="dialog-content"]')?.scrollTop ?? 0,
        username: http?.username,
        password: http?.password,
        bearer: http?.bearer,
      })
    disposed = true
    epoch++
    abort.abort()
    clearInterval(poll)
    clearInterval(clock)
  })

  return (
    <section
      ref={section}
      aria-label={language.t("attention.title")}
      aria-busy={state.loading}
      class="w-full min-w-0 px-4 pb-4 flex flex-col gap-3 text-13-regular"
    >
      <Show when={state.switched}>
        <p role="status">{language.t("attention.serverChanged")}</p>
      </Show>
      <Show when={!state.switched}>
        <div class="flex flex-wrap items-end gap-2">
          <label class="flex flex-col gap-1 min-w-0">
            <span class="text-text-weak">{language.t("attention.filter.kind")}</span>
            <select
              class="rounded-md border border-border-weak-base bg-background-base px-2 py-1.5"
              value={state.kind}
              onChange={(event) => setState("kind", event.currentTarget.value as AttentionItem["kind"] | "all")}
            >
              <option value="all">{language.t("attention.kind.all")}</option>
              <option value="activity_failed">{language.t("attention.kind.activity_failed")}</option>
              <option value="execution_recovery">{language.t("attention.kind.execution_recovery")}</option>
              <option value="no_progress">{language.t("attention.kind.no_progress")}</option>
              <option value="task">{language.t("attention.kind.task")}</option>
              <option value="goal">{language.t("attention.kind.goal")}</option>
            </select>
          </label>
          <label class="flex flex-col gap-1 min-w-0">
            <span class="text-text-weak">{language.t("attention.filter.view")}</span>
            <select
              class="rounded-md border border-border-weak-base bg-background-base px-2 py-1.5"
              value={state.view}
              onChange={(event) => setState("view", event.currentTarget.value as "all" | "unseen")}
            >
              <option value="all">{language.t("attention.view.all")}</option>
              <option value="unseen">{language.t("attention.view.unseen")}</option>
            </select>
          </label>
          <Button
            size="small"
            onClick={() => (state.capability ? void refresh() : void load())}
            disabled={state.loading || !!state.acting || state.capability?.enabled === false}
          >
            {language.t("attention.refresh")}
          </Button>
        </div>
        <Show when={state.capability && !state.capability!.enabled}>
          <p role="status">
            {language.t(
              state.capability?.reason === "profile_disabled"
                ? "attention.disabled.profile"
                : "attention.disabled.host",
            )}
          </p>
        </Show>
        <Show when={state.loading && !state.list}>
          <p role="status">{language.t("attention.loading")}</p>
        </Show>
        <Show when={state.error}>
          <p role="alert" class="text-text-weak">
            {language.t(state.list ? "attention.stale" : "attention.loadError")}
          </p>
        </Show>
        <Show when={state.notice}>{(value) => <p role="alert">{language.t(`attention.${value()}`)}</p>}</Show>
        <Show when={state.controlError}>
          {(value) => <p role="alert">{language.t(`attention.control.${value()}`)}</p>}
        </Show>
        <Show when={state.controlError === "unknown" ? state.command : undefined} keyed>
          {(command) => (
            <div class="rounded-md border border-border-weak-base p-3 flex flex-col gap-2">
              <p>
                {command.item.session.title} ·{" "}
                {language.t(
                  `attention.action.${
                    command.kind === "task" ? `task_${command.body.action}` : `goal_${command.action}`
                  }`,
                )}
              </p>
              <Show when={command.kind === "task" ? command.body.reason : undefined}>
                {(reason) => <p class="whitespace-pre-wrap break-words">{reason()}</p>}
              </Show>
              <Button class="self-start" disabled={!!state.acting} onClick={() => void control(command.item, "", true)}>
                {language.t("attention.control.retry")}
              </Button>
            </div>
          )}
        </Show>
        <Show when={state.list}>
          {(result) => (
            <>
              <p class="text-text-weak text-12-regular" role="status">
                {language.t("attention.summary", { count: result().unseenCount, time: date(result().asOf) })}
              </p>
              <Show when={result().data.length === 0}>
                <p class="py-6 text-center text-text-weak">{language.t("attention.empty")}</p>
              </Show>
              <ul class="flex flex-col gap-2 list-none m-0 p-0">
                <For each={result().data.map((item) => item.id)}>
                  {(id) => {
                    const initial = untrack(() => result().data.find((item) => item.id === id)!)
                    const item = createMemo(() => result().data.find((entry) => entry.id === id) ?? initial)
                    return (
                      <li class="rounded-lg border border-border-weak-base p-3 min-w-0" data-attention-id={item().id}>
                        <div class="flex flex-wrap items-start justify-between gap-2">
                          <div class="min-w-0 flex-1">
                            <p class="font-medium break-words">{item().session.title || item().session.id}</p>
                            <p class="text-text-weak text-12-regular break-all">{item().session.directory}</p>
                          </div>
                          <span class="text-12-regular text-text-weak">
                            {language.t(item().seen ? "attention.seen" : "attention.unseen")}
                          </span>
                        </div>
                        <p class="mt-2">
                          <span>{language.t(`attention.kind.${item().kind}`)}</span> ·{" "}
                          <span>{language.t(`attention.state.${item().state}`)}</span>
                        </p>
                        <p class="text-12-regular text-text-weak">{date(item().occurredAt)}</p>
                        <div class="flex flex-wrap gap-2 mt-2">
                          <Button
                            size="small"
                            variant="ghost"
                            disabled={state.detailLoading || !!state.acting}
                            onClick={() => void loadDetail(item())}
                          >
                            {language.t("attention.details")}
                          </Button>
                          <Button
                            size="small"
                            disabled={state.detailLoading || !!state.acting}
                            onClick={() => void loadDetail(item(), true)}
                          >
                            {language.t("attention.openSession")}
                          </Button>
                          <Button
                            size="small"
                            variant="ghost"
                            disabled={item().seen || !!state.marking || !!state.acting}
                            onClick={() => void markSeen(item())}
                          >
                            {language.t("attention.markSeen")}
                          </Button>
                        </div>
                        <Show when={state.selected?.id === item().id ? state.selected : undefined}>
                          {(detail) => (
                            <div
                              class="border-t border-border-weak-base mt-3 pt-3 break-words"
                              aria-label={language.t("attention.details")}
                            >
                              <p>{language.t(`attention.reason.${detail().reasonCode}`)}</p>
                              <p class="text-text-weak mt-1">{language.t("attention.seenHelp")}</p>
                              <Show when={detail().source.task}>
                                {(task) => (
                                  <>
                                    <dl class="text-12-regular mt-2 break-all">
                                      <dt>{language.t("attention.source.parent")}</dt>
                                      <dd>{task().parentSessionID}</dd>
                                      <dt>{language.t("attention.source.child")}</dt>
                                      <dd>
                                        {task().childSessionID ?? language.t("attention.source.childUnavailable")}
                                      </dd>
                                      <dt>{language.t("attention.source.pendingEffects")}</dt>
                                      <dd>
                                        {task().pendingProviders +
                                          task().pendingProviderAttempts +
                                          task().pendingToolEffects}
                                      </dd>
                                      <dt>{language.t("attention.source.claim")}</dt>
                                      <dd>
                                        {language.t(
                                          task().hasExecutionClaim ? "attention.source.yes" : "attention.source.no",
                                        )}
                                      </dd>
                                    </dl>
                                    <Show when={task().controlState === "close_requested"}>
                                      <p class="mt-2">{language.t("attention.source.closeIntent")}</p>
                                    </Show>
                                    <Button
                                      size="small"
                                      variant="ghost"
                                      disabled={state.detailLoading || !!state.acting}
                                      onClick={() => void loadDetail(detail(), true, true)}
                                    >
                                      {language.t("attention.source.openParent")}
                                    </Button>
                                  </>
                                )}
                              </Show>
                              <Show when={detail().source.goal}>
                                {(goal) => (
                                  <dl class="text-12-regular mt-2 break-all">
                                    <dt>{language.t("attention.source.goal")}</dt>
                                    <dd>{goal().goalID}</dd>
                                    <dt>{language.t("attention.source.planRevision")}</dt>
                                    <dd>{goal().planRevision}</dd>
                                    <dt>{language.t("attention.source.pendingRebase")}</dt>
                                    <dd>
                                      {language.t(
                                        goal().pendingRebase ? "attention.source.yes" : "attention.source.no",
                                      )}
                                    </dd>
                                    <dt>{language.t("attention.source.pendingPermits")}</dt>
                                    <dd>{goal().pendingPermits}</dd>
                                    <dt>{language.t("attention.source.unknownPermits")}</dt>
                                    <dd>{goal().unknownPermits}</dd>
                                    <dt>{language.t("attention.source.controls")}</dt>
                                    <dd>{language.t("attention.source.controlsHelp")}</dd>
                                  </dl>
                                )}
                              </Show>
                              <Show
                                when={
                                  detail().kind === "task" &&
                                  taskActions.some((action) => advertises(detail(), `task_${action}`))
                                }
                              >
                                <label class="flex flex-col gap-1 mt-2">
                                  {language.t("attention.control.reason")}
                                  <textarea
                                    rows={3}
                                    disabled={!!state.acting || !!state.command}
                                    value={state.reason}
                                    onInput={(event) => setState("reason", event.currentTarget.value)}
                                    class="rounded-md border border-border-weak-base bg-background-base p-2"
                                  />
                                </label>
                                <p class="text-12-regular text-text-weak">{language.t("attention.control.taskHelp")}</p>
                              </Show>
                              <div class="flex flex-wrap gap-2 mt-2">
                                <For
                                  each={[
                                    ...taskActions.map((action) => `task_${action}`),
                                    ...goalActions.map((action) => `goal_${action}`),
                                  ].filter((action) => advertises(detail(), action))}
                                >
                                  {(action) => (
                                    <>
                                      <Button
                                        disabled={
                                          !!state.acting ||
                                          !!state.marking ||
                                          !!state.command ||
                                          (action.startsWith("task_") && !validReason(state.reason))
                                        }
                                        onClick={() =>
                                          setState("controlConfirm", `${detail().id}:${detail().revision}:${action}`)
                                        }
                                      >
                                        {language.t(`attention.action.${action}`)}
                                      </Button>
                                      <Show
                                        when={state.controlConfirm === `${detail().id}:${detail().revision}:${action}`}
                                      >
                                        <Button
                                          disabled={!!state.acting || !!state.command}
                                          onClick={() => void control(detail(), action)}
                                        >
                                          {language.t("attention.control.confirm")}
                                        </Button>
                                      </Show>
                                    </>
                                  )}
                                </For>
                              </div>
                              <Show when={detail().kind === "no_progress"}>
                                <p class="mt-2">{language.t("attention.approvalHelp")}</p>
                                <p>
                                  {language.t("attention.approvalExpires", { time: date(detail().source.expiresAt) })}
                                </p>
                                <div class="flex flex-wrap gap-2 mt-2">
                                  <Show when={detail().allowedActions?.includes("continue_once")}>
                                    <Button
                                      disabled={
                                        !!state.acting ||
                                        !!state.marking ||
                                        !approvalAllowed(detail(), "continue_once", state.now)
                                      }
                                      onClick={() => void approve(detail(), "continue_once")}
                                    >
                                      {language.t(
                                        state.acting === detail().id ? "attention.acting" : "attention.continueOnce",
                                      )}
                                    </Button>
                                  </Show>
                                  <Show when={detail().allowedActions?.includes("terminate")}>
                                    <Button
                                      disabled={
                                        !!state.acting ||
                                        !!state.marking ||
                                        !approvalAllowed(detail(), "terminate", state.now)
                                      }
                                      onClick={() => setState("confirming", `${detail().id}:${detail().revision}`)}
                                    >
                                      {language.t("attention.terminate")}
                                    </Button>
                                  </Show>
                                  <Show when={state.confirming === `${detail().id}:${detail().revision}`}>
                                    <Button
                                      disabled={!!state.acting || !approvalAllowed(detail(), "terminate", state.now)}
                                      onClick={() => void approve(detail(), "terminate")}
                                    >
                                      {language.t("attention.confirmTerminate")}
                                    </Button>
                                  </Show>
                                </div>
                              </Show>
                              <dl class="text-12-regular text-text-weak mt-2 break-all">
                                <dt>{language.t("attention.session")}</dt>
                                <dd>{detail().session.id}</dd>
                                <Show when={detail().source.activityID}>
                                  <dt>{language.t("attention.activity")}</dt>
                                  <dd>{detail().source.activityID}</dd>
                                </Show>
                              </dl>
                            </div>
                          )}
                        </Show>
                      </li>
                    )
                  }}
                </For>
              </ul>
              <Show when={result().nextCursor}>
                <Button disabled={state.loading} onClick={() => void refresh(true)}>
                  {language.t("attention.more")}
                </Button>
              </Show>
            </>
          )}
        </Show>
      </Show>
    </section>
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
