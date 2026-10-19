import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import type { VcsRefs, VcsWorkSummary } from "@deepagent-code/sdk"
import { Dialog } from "@kobalte/core/dialog"
import { Icon } from "@deepagent-code/ui/icon"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { Button } from "@deepagent-code/ui/button"
import { TaskSummarySchema } from "@deepagent-code/core/session/task-summary.schema"
import { Schema } from "effect"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { useSessionLayout } from "./session-layout"

type TaskSummaryClient = ReturnType<typeof useSDK>["client"]
const taskSummaries = new WeakMap<TaskSummaryClient, Map<string, ReturnType<typeof createTaskSummarySource>>>()

function createTaskSummarySource(client: TaskSummaryClient, sessionID: string, dispose: () => void) {
  const [state, setState] = createStore({
    summary: undefined as TaskSummarySchema.Summary | undefined,
    failed: false,
    loading: false,
    pages: 1,
  })
  const lifetime = new AbortController()
  let references = 0
  let busy = false
  let request: AbortController | undefined
  const hidden = () => document.visibilityState === "hidden"
  const read = async (more = false) => {
    if (busy || lifetime.signal.aborted || hidden()) return
    if (more && !state.summary?.hasMore) return
    busy = true
    setState("loading", true)
    try {
      request = new AbortController()
      const signal = AbortSignal.any([lifetime.signal, request.signal, AbortSignal.timeout(10_000)])
      const page = async (cursor?: string) => {
        const result = await client.session.taskSummary({ sessionID, ...(cursor ? { cursor } : {}) }, { signal })
        const value = Schema.decodeUnknownSync(TaskSummarySchema.Summary)(result.data)
        if (value.parentSessionID !== sessionID) throw new Error("Task summary scope changed")
        return value
      }
      const pages: TaskSummarySchema.Summary[] = []
      for (let index = 0; index < state.pages + Number(more); index++) {
        pages.push(await page(pages.at(-1)?.nextCursor ?? undefined))
        if (!pages.at(-1)?.hasMore) break
        if (!pages.at(-1)?.nextCursor) throw new Error("Task summary cursor missing")
      }
      if (more && pages.length > 1) {
        const first = await page()
        if (
          first.nextCursor !== pages[0]!.nextCursor ||
          first.items.map((item) => item.childSessionID).join() !==
            pages[0]!.items.map((item) => item.childSessionID).join()
        )
          throw new Error("Task summary list changed while paging")
        pages[0] = first
      }
      if (lifetime.signal.aborted || signal.aborted) return
      const last = pages.at(-1)!
      const items = new Map<string, TaskSummarySchema.Item>()
      pages
        .flatMap((value) => value.items)
        .forEach((item) => {
          const previous = items.get(item.childSessionID)
          if (previous && (previous.generation ?? -1) > (item.generation ?? -1)) return
          items.set(item.childSessionID, item)
        })
      setState({
        summary: {
          ...last,
          observedAt: Math.max(...pages.map((value) => value.observedAt)),
          items: [...items.values()],
        },
        pages: pages.length,
        failed: false,
      })
    } catch {
      if (!lifetime.signal.aborted && !hidden()) setState("failed", true)
    } finally {
      busy = false
      request = undefined
      if (!lifetime.signal.aborted) setState("loading", false)
    }
  }
  const refresh = () => void read()
  untrack(refresh)
  const timer = setInterval(refresh, 5_000)
  const visibility = () => {
    if (document.visibilityState === "hidden") {
      request?.abort()
      return
    }
    refresh()
  }
  document.addEventListener("visibilitychange", visibility)
  return {
    state,
    loadMore: () => void read(true),
    retain() {
      references++
      let released = false
      return () => {
        if (released) return
        released = true
        if (--references) return
        lifetime.abort()
        clearInterval(timer)
        document.removeEventListener("visibilitychange", visibility)
        dispose()
      }
    },
  }
}

function useTaskSummary(enabled: () => boolean) {
  const sdk = useSDK()
  const { params } = useSessionLayout()
  const [source, setSource] = createSignal<ReturnType<typeof createTaskSummarySource>>()
  createEffect(() => {
    const sessionID = params.id
    const client = sdk.client
    const key = JSON.stringify([sdk.scope, sdk.directory, sessionID])
    if (!enabled() || !sessionID) {
      setSource(undefined)
      return
    }
    // The popover and details share one reader, including when both are visible.
    const sources = taskSummaries.get(client) ?? new Map<string, ReturnType<typeof createTaskSummarySource>>()
    taskSummaries.set(client, sources)
    const current = sources.get(key) ?? createTaskSummarySource(client, sessionID, () => sources.delete(key))
    sources.set(key, current)
    setSource(current)
    const release = current.retain()
    onCleanup(() => {
      release()
      setSource(undefined)
    })
  })
  return {
    summary: () => source()?.state.summary,
    failed: () => source()?.state.failed ?? false,
    loading: () => source()?.state.loading ?? false,
    loadMore: () => source()?.loadMore(),
  }
}

function taskLabel(item: TaskSummarySchema.Item, text: (key: string) => string) {
  if (item.state === "unknown" && item.runID === null && item.result.state === "available")
    return `${text("result")}: ${text("resultState.available")}`
  return text(`taskState.${item.state}`)
}

export type TaskProgressGit = {
  summary?: VcsWorkSummary
  loading: boolean
  failed: boolean
  baseRef?: string
  refs: VcsRefs["items"]
  refsLoading: boolean
  refsFailed?: boolean
  refsTruncated?: boolean
  onOpenRefs: () => void
  onBaseRefChange: (ref: string) => void
  onOpenReview: () => void
  onRefresh: () => void
}

export function TaskProgressPopover(
  props: { open?: boolean; onOpenChange?: (open: boolean) => void; git?: TaskProgressGit } = {},
) {
  const language = useLanguage()
  const sdk = useSDK()
  const serverSync = useServerSync()
  const { params } = useSessionLayout()
  const [ui, setUi] = createStore({
    opened: false,
    expanded: undefined as "plan" | "tasks" | undefined,
    selected: undefined as string | undefined,
    trigger: undefined as HTMLElement | undefined,
    mount: undefined as HTMLElement | undefined,
  })
  const opened = () => props.open ?? ui.opened
  const setOpened = (open: boolean) => {
    props.onOpenChange?.(open)
    if (props.open === undefined) setUi("opened", open)
  }
  const scope = createMemo(() => JSON.stringify([sdk.scope, sdk.directory, params.id]))
  createEffect(
    on(
      scope,
      () => {
        setUi({ expanded: undefined, selected: undefined })
        setOpened(false)
      },
      { defer: true },
    ),
  )
  createEffect(() => {
    if (!opened()) return
    const element = ui.trigger
    // The fallback belongs to an isolated component, never to the app-wide body.
    setUi(
      "mount",
      element?.closest<HTMLElement>("[data-session-overview-scope]") ?? element?.parentElement ?? undefined,
    )
  })
  const state = useTaskSummary(opened)
  const plan = createMemo(() => (params.id ? serverSync.data.session_plan[params.id] : undefined))
  const completed = createMemo(
    () => plan()?.steps.filter((step) => step.status === "done" || step.status === "completed").length ?? 0,
  )
  const active = createMemo(
    () =>
      plan()?.steps.find((step) => step.step_id === plan()?.active_step_id) ??
      plan()?.steps.find((step) => step.status === "active" || step.status === "in_progress"),
  )
  const text = (key: string) => language.t(`workPanel.${key}` as Parameters<typeof language.t>[0])
  const stepStatus = (status: string) => {
    if (status === "done" || status === "completed") return text("taskState.completed")
    if (status === "active" || status === "in_progress") return language.t("goal.plan.stepState.active")
    if (status === "cancelled" || status === "canceled") return language.t("goal.plan.stepState.cancelled")
    if (status === "blocked") return language.t("goal.plan.stepState.blocked")
    if (status === "pending") return language.t("goal.plan.stepState.pending")
    return text("taskState.unknown")
  }
  const live = (item: TaskSummarySchema.Item) =>
    [
      "admitted",
      "provisioning",
      "researching",
      "finalizing",
      "queued",
      "running",
      "recovery_required",
      "error",
      "failed",
    ].includes(item.state) ||
    item.notification.state === "dead" ||
    item.notification.state === "response_recovery_required"
  const items = createMemo(() => state.summary()?.items ?? [])
  const shown = createMemo(() => (ui.expanded === "tasks" ? items() : items().filter(live).slice(0, 2)))
  const selected = createMemo(() => items().find((item) => item.childSessionID === ui.selected))
  const summary = () => props.git?.summary
  const base = () => props.git?.baseRef ?? summary()?.baseRef ?? ""
  const shortRef = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, "")
  const toggle = (group: "plan" | "tasks") =>
    setUi({ expanded: ui.expanded === group ? undefined : group, selected: undefined })
  return (
    <Show when={params.id}>
      <div class="relative inline-flex shrink-0" data-slot="task-progress-owner">
        <Dialog open={opened()} onOpenChange={setOpened} modal={false} preventScroll={false}>
          <Dialog.Trigger
            ref={(element) => setUi("trigger", element)}
            type="button"
            class="inline-flex size-6 items-center justify-center rounded-md p-0 box-border shrink-0 hover:bg-surface-base-hover data-[expanded]:bg-surface-base-active"
            title={text("overview")}
            aria-label={text("overview")}
          >
            <Icon name="checklist" size="small" />
          </Dialog.Trigger>
          <Show when={ui.mount}>
            {(mount) => (
              <Dialog.Portal mount={mount()}>
                <Dialog.Content
                  data-component="task-progress-card"
                  data-slot="session-task-dock"
                  onOpenAutoFocus={(event) => event.preventDefault()}
                  onInteractOutside={(event) => event.preventDefault()}
                  class="absolute right-3 top-14 z-50 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[20px] shadow-xl"
                  style={{
                    width: "380px",
                    "max-width": "calc(100% - 24px)",
                    "max-height": "max(0px, min(560px, 70%, calc(100% - 68px)))",
                    "background-color": "var(--surface-raised-stronger-non-alpha)",
                    border: "1px solid color-mix(in oklch, var(--border-base) 50%, transparent)",
                  }}
                >
                  <div class="flex shrink-0 items-center justify-between gap-2 px-3 pt-3">
                    <Dialog.Title class="text-13-medium text-text-strong">{text("overview")}</Dialog.Title>
                    <Dialog.CloseButton
                      as={IconButton}
                      icon="close"
                      variant="ghost"
                      aria-label={language.t("common.close")}
                    />
                  </div>
                  <div class="min-h-0 flex-1 overflow-y-auto p-3" data-slot="task-progress-body">
                    <div class="px-2 pb-2 space-y-5" data-slot="task-progress-summary">
                      <Show when={props.git}>
                        <section aria-label={text("changes")} data-slot="task-progress-git" class="space-y-2">
                          <div class="flex min-w-0 items-center gap-2 text-13-medium">
                            <Icon name="branch" size="small" />
                            <button
                              type="button"
                              class="min-w-0 truncate hover:text-text-strong"
                              onClick={() => props.git?.onOpenReview()}
                              title={text("compareMeaning")}
                            >
                              {summary()?.branch ?? summary()?.headOID?.slice(0, 8) ?? "—"} →
                            </button>
                            <label class="min-w-0 flex-1">
                              <span class="sr-only">{text("referenceBranch")}</span>
                              <select
                                aria-label={text("referenceBranch")}
                                class="w-full min-w-0 rounded-md bg-surface-base px-2 py-1 text-12-regular"
                                value={base()}
                                onFocus={() => props.git?.onOpenRefs()}
                                onChange={(event) => props.git?.onBaseRefChange(event.currentTarget.value)}
                              >
                                <Show
                                  when={!props.git?.refs.some((item) => item.ref === base() || item.name === base())}
                                >
                                  <option value={base()}>{base() ? shortRef(base()) : text("referenceBranch")}</option>
                                </Show>
                                <For each={props.git?.refs}>
                                  {(item) => (
                                    <option value={item.ref}>
                                      {item.name} · {text(item.kind === "remote" ? "cachedRemote" : "localBranch")}
                                    </option>
                                  )}
                                </For>
                              </select>
                            </label>
                          </div>
                          <button
                            type="button"
                            class="flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-12-regular hover:bg-surface-raised-base-hover"
                            onClick={() => props.git?.onOpenReview()}
                          >
                            <Show
                              when={summary()?.state === "ready"}
                              fallback={
                                <span class="text-text-weak">
                                  {props.git?.failed
                                    ? language.t("common.requestFailed")
                                    : props.git?.loading
                                      ? language.t("common.loading")
                                      : text(`gitState.${summary()?.state ?? "unavailable"}`)}
                                </span>
                              }
                            >
                              <span>
                                {summary()?.coverage === "partial" ? "≥" : ""}
                                {summary()?.files} {text("changedFiles")}
                              </span>
                              <span class="text-text-weak">
                                <Show
                                  when={
                                    summary()?.lineStatsComplete ||
                                    (summary()?.additions ?? 0) + (summary()?.deletions ?? 0) > 0
                                  }
                                  fallback={text("lineStatsPartial")}
                                >
                                  +{summary()?.additions} / −{summary()?.deletions}
                                  <Show when={!summary()?.lineStatsComplete}> · {text("lineStatsPartial")}</Show>
                                </Show>
                              </span>
                            </Show>
                            <Icon name="chevron-right" size="small" />
                          </button>
                          <Show when={props.git?.refsLoading || props.git?.refsFailed || props.git?.refsTruncated}>
                            <p role="status" class="text-11-regular text-text-weak">
                              {props.git?.refsLoading
                                ? language.t("common.loading")
                                : props.git?.refsFailed
                                  ? language.t("common.requestFailed")
                                  : text("refsPartial")}
                            </p>
                          </Show>
                          <p class="text-11-regular text-text-weak">{text("compareMeaning")}</p>
                          <Show when={summary()}>
                            {(value) => (
                              <p class="text-11-regular text-text-weak">
                                {value().stale || props.git?.failed ? text("snapshotStale") : text("observed")} ·{" "}
                                {new Date(value().observedAt).toLocaleTimeString()}
                                <Show when={value().conflicts}>
                                  {" "}
                                  · {value().conflicts} {text("conflicts")}
                                </Show>
                                <Show when={value().binary}>
                                  {" "}
                                  · {value().binary} {text("binaryFiles")}
                                </Show>
                              </p>
                            )}
                          </Show>
                          <button
                            type="button"
                            class="text-11-regular text-text-weak underline"
                            disabled={props.git?.loading}
                            onClick={() => props.git?.onRefresh()}
                          >
                            {text("refreshOverview")}
                          </button>
                        </section>
                      </Show>
                      <section data-slot="task-progress-plan" aria-label={text("currentPlan")}>
                        <button
                          type="button"
                          class="flex w-full items-center justify-between gap-2 text-left text-13-medium"
                          aria-expanded={ui.expanded === "plan"}
                          onClick={() => toggle("plan")}
                        >
                          <span>{text("currentPlan")}</span>
                          <span class="text-12-regular text-text-weak">
                            <Show when={plan()}>
                              {completed()}/{plan()?.steps.length}
                            </Show>{" "}
                            <Icon name={ui.expanded === "plan" ? "chevron-down" : "chevron-right"} size="small" />
                          </span>
                        </button>
                        <Show
                          when={plan()}
                          fallback={<p class="mt-2 text-12-regular text-text-weak">{text("planEmpty")}</p>}
                        >
                          {(current) => (
                            <>
                              <p class="mt-2 truncate text-12-regular" title={current().goal}>
                                {current().goal}
                              </p>
                              <Show when={ui.expanded !== "plan" && active()}>
                                {(step) => (
                                  <p class="mt-1 truncate text-12-regular text-text-weak" title={step().title}>
                                    {step().title}
                                  </p>
                                )}
                              </Show>
                              <Show when={ui.expanded === "plan"}>
                                <ol class="mt-2 space-y-1">
                                  <For each={current().steps}>
                                    {(step) => (
                                      <li class="flex items-start gap-2 rounded-md py-1 text-12-regular">
                                        <Icon
                                          name={
                                            step.status === "done" || step.status === "completed"
                                              ? "check"
                                              : "chevron-right"
                                          }
                                          size="small"
                                        />
                                        <span class="min-w-0 flex-1 break-words">{step.title}</span>
                                        <span class="shrink-0 text-11-regular text-text-weak">
                                          {stepStatus(step.status)}
                                        </span>
                                      </li>
                                    )}
                                  </For>
                                </ol>
                              </Show>
                            </>
                          )}
                        </Show>
                      </section>
                      <section data-slot="task-progress-subtasks" aria-label={text("subtasks")}>
                        <button
                          type="button"
                          class="flex w-full items-center justify-between gap-2 text-left text-13-medium"
                          aria-expanded={ui.expanded === "tasks"}
                          onClick={() => toggle("tasks")}
                        >
                          <span>{text("subtasks")}</span>
                          <span class="text-12-regular text-text-weak">
                            <Show when={state.summary()}>
                              {items().length}
                              {state.summary()?.hasMore ? "+" : ""}
                            </Show>{" "}
                            <Icon name={ui.expanded === "tasks" ? "chevron-down" : "chevron-right"} size="small" />
                          </span>
                        </button>
                        <Show when={state.summary()}>
                          <p class="mt-2 text-11-regular text-text-weak">
                            {text("activeTasks")} {items().filter(live).length} · {text("taskState.completed")}{" "}
                            {items().filter((item) => item.state === "completed").length}
                            <Show when={state.summary()?.hasMore}> · {text("loadedOnly")}</Show>
                          </p>
                        </Show>
                        <Show when={!state.summary()}>
                          <p role="status" class="mt-2 text-12-regular text-text-weak">
                            {state.failed()
                              ? language.t("common.requestFailed")
                              : state.loading()
                                ? language.t("common.loading")
                                : text("tasksPending")}
                          </p>
                        </Show>
                        <Show when={state.failed() && state.summary()}>
                          <p role="status" class="mt-2 text-12-regular text-text-weak">
                            {text("snapshotStale")} · {language.t("common.requestFailed")}
                          </p>
                        </Show>
                        <For
                          each={shown()}
                          fallback={
                            <Show when={state.summary() && !items().length}>
                              <p class="mt-2 text-12-regular text-text-weak">{text("tasksEmpty")}</p>
                            </Show>
                          }
                        >
                          {(item) => (
                            <button
                              type="button"
                              class="mt-2 flex w-full min-w-0 items-center gap-2 rounded-md py-2 text-left hover:bg-surface-raised-base-hover"
                              onClick={() =>
                                setUi({
                                  expanded: "tasks",
                                  selected: ui.selected === item.childSessionID ? undefined : item.childSessionID,
                                })
                              }
                            >
                              <Icon name="agent-tree" size="small" />
                              <span class="min-w-0 flex-1">
                                <span class="block truncate text-12-medium" title={item.title}>
                                  {item.title || item.agent || item.childSessionID}
                                </span>
                                <span class="block text-11-regular text-text-weak">{taskLabel(item, text)}</span>
                              </span>
                              <Icon name="chevron-right" size="small" />
                            </button>
                          )}
                        </For>
                        <Show when={ui.expanded === "tasks" && state.summary()?.hasMore}>
                          <Button
                            variant="ghost"
                            class="mt-2"
                            disabled={state.loading()}
                            onClick={() => state.loadMore()}
                          >
                            {state.loading() ? language.t("common.loading") : text("loadMoreTasks")}
                          </Button>
                        </Show>
                        <Show when={selected()}>{(item) => <TaskReadonlyContent item={item()} />}</Show>
                      </section>
                    </div>
                  </div>
                </Dialog.Content>
              </Dialog.Portal>
            )}
          </Show>
        </Dialog>
      </div>
    </Show>
  )
}

export function TaskProgressDetails() {
  const language = useLanguage()
  const { view } = useSessionLayout()
  const state = useTaskSummary(() => true)
  const text = (key: string) => language.t(`workPanel.${key}` as Parameters<typeof language.t>[0])
  const selected = () =>
    state.summary()?.items.find((item) => item.childSessionID === view().workPanel.taskID()) ??
    state.summary()?.items[0]
  return (
    <div class="h-full overflow-y-auto px-4 py-3" data-slot="task-progress-details">
      <h3 class="text-13-medium">{text("tasksReadonly")}</h3>
      <Show when={!state.summary() && !state.failed()}>
        <p role="status" class="mt-3 text-12-regular text-text-weak">
          {state.loading() ? language.t("common.loading") : text("tasksPending")}
        </p>
      </Show>
      <Show when={state.failed()}>
        <p role="status" class="mt-3 text-12-regular text-text-weak">
          {language.t("common.requestFailed")}
        </p>
      </Show>
      <For each={state.summary()?.items}>
        {(item) => (
          <button
            type="button"
            class="mt-2 block w-full rounded-md px-2 py-2 text-left text-12-regular hover:bg-surface-raised-base-hover"
            classList={{ "bg-surface-raised-base": selected()?.childSessionID === item.childSessionID }}
            onClick={() => view().workPanel.selectTask(item.childSessionID)}
          >
            {item.title}
            <span class="ml-2 text-text-weak">{taskLabel(item, text)}</span>
          </button>
        )}
      </For>
      <Show
        when={selected()}
        fallback={
          <Show when={!!state.summary() && !state.loading() && !state.failed()}>
            <p class="mt-4 text-12-regular text-text-weak">{text("tasksEmpty")}</p>
          </Show>
        }
      >
        {(item) => <TaskReadonlyContent item={item()} />}
      </Show>
      <Button
        variant="ghost"
        class="mt-4"
        onClick={() => {
          view().workPanel.hide()
          document.querySelector<HTMLElement>('[data-component="prompt-input"][contenteditable="true"]')?.focus()
        }}
      >
        {text("returnMain")}
      </Button>
    </div>
  )
}

function TaskReadonlyContent(props: { item: TaskSummarySchema.Item }) {
  const language = useLanguage()
  const text = (key: string) => language.t(`workPanel.${key}` as Parameters<typeof language.t>[0])
  return (
    <section class="mt-4 rounded-lg bg-surface-raised-base p-3 text-12-regular">
      <h4 class="text-13-medium">{props.item.title}</h4>
      <p class="mt-1 text-text-weak">{props.item.agent}</p>
      <Show when={props.item.state === "unknown"}>
        <p class="mt-1 text-text-weak">{text("taskState.unknown")}</p>
      </Show>
      <Show when={props.item.controlState === "close_requested"}>
        <p class="mt-2 text-text-warning">{text("taskState.close_requested")}</p>
      </Show>
      <Show when={props.item.progress?.text && props.item.progress?.text !== props.item.result.text}>
        <p class="mt-3 whitespace-pre-wrap break-words">{props.item.progress?.text}</p>
      </Show>
      <Show when={props.item.progress?.tool}>
        {(tool) => (
          <p class="mt-2 text-text-weak">
            {tool().name} · {tool().status}
          </p>
        )}
      </Show>
      <p class="mt-3 text-text-weak">
        {text("result")}: {text(`resultState.${props.item.result.state}`)}
      </p>
      <Show when={props.item.result.text}>
        <p class="mt-2 whitespace-pre-wrap break-words">{props.item.result.text}</p>
      </Show>
      <Show when={props.item.result.truncated}>
        <p class="mt-1 text-text-weak">{text("resultTruncated")}</p>
      </Show>
      <p class="mt-3 text-text-weak">
        {text("notification")}: {text(`notificationState.${props.item.notification.state}`)}
      </p>
    </section>
  )
}
