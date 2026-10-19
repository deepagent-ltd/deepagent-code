import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Popover } from "@deepagent-code/ui/popover"
import { Icon } from "@deepagent-code/ui/icon"
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
  })
  const lifetime = new AbortController()
  let references = 0
  let busy = false
  const read = async () => {
    if (busy || lifetime.signal.aborted || document.visibilityState === "hidden") return
    busy = true
    setState("loading", true)
    try {
      const result = await client.session.taskSummary(
        { sessionID },
        { signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]) },
      )
      const value = Schema.decodeUnknownSync(TaskSummarySchema.Summary)(result.data)
      if (lifetime.signal.aborted) return
      if (value.parentSessionID !== sessionID) throw new Error("Task summary scope changed")
      setState("summary", value)
      setState("failed", false)
    } catch {
      if (!lifetime.signal.aborted) setState("failed", true)
    } finally {
      busy = false
      if (!lifetime.signal.aborted) setState("loading", false)
    }
  }
  void read()
  const timer = setInterval(() => void read(), 5_000)
  document.addEventListener("visibilitychange", read)
  return {
    state,
    retain() {
      references++
      let released = false
      return () => {
        if (released) return
        released = true
        if (--references) return
        lifetime.abort()
        clearInterval(timer)
        document.removeEventListener("visibilitychange", read)
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
  }
}

function taskLabel(item: TaskSummarySchema.Item, text: (key: string) => string) {
  if (item.state === "unknown" && item.runID === null && item.result.state === "available")
    return `${text("result")}: ${text("resultState.available")}`
  return text(`taskState.${item.state}`)
}

export function TaskProgressPopover() {
  const language = useLanguage()
  const serverSync = useServerSync()
  const { params, view } = useSessionLayout()
  const [opened, setOpened] = createSignal(false)
  const state = useTaskSummary(opened)
  const plan = createMemo(() => (params.id ? serverSync.data.session_plan[params.id] : undefined))
  const completed = createMemo(
    () => plan()?.steps.filter((step) => step.status === "done" || step.status === "completed").length ?? 0,
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
  const select = (item: TaskSummarySchema.Item) => {
    view().workPanel.selectTask(item.childSessionID)
    view().workPanel.open("subagents")
    setOpened(false)
  }
  return (
    <Show when={params.id}>
      <Popover
        open={opened()}
        onOpenChange={setOpened}
        placement="bottom-end"
        title={text("tasks")}
        triggerAs="button"
        triggerProps={{
          type: "button",
          class: "titlebar-icon inline-flex w-8 h-6 items-center justify-center p-0 box-border shrink-0",
          title: text("tasks"),
          "aria-label": text("tasks"),
        }}
        trigger={<Icon name="checklist" size="small" />}
        class="w-80 max-w-[calc(100vw-32px)]"
      >
        <div class="max-h-80 overflow-y-auto p-2" data-slot="task-progress-summary">
          <section
            class="border-b border-border-weak-base pb-2"
            data-slot="task-progress-plan"
            aria-label={text("currentPlan")}
          >
            <h3 class="flex items-center justify-between gap-2 px-2 py-1 text-12-medium">
              {text("currentPlan")}
              <Show when={plan()}>
                {(current) => (
                  <span class="text-text-weak">
                    {completed()}/{current().steps.length}
                  </span>
                )}
              </Show>
            </h3>
            <Show when={plan()} fallback={<p class="p-2 text-12-regular text-text-weak">{text("planEmpty")}</p>}>
              {(current) => (
                <>
                  <p class="px-2 py-1 text-12-regular break-words">{current().goal}</p>
                  <ol class="space-y-1">
                    <For each={current().steps}>
                      {(step) => (
                        <li class="flex items-start gap-2 px-2 py-1 text-12-regular">
                          <Show
                            when={step.status === "done" || step.status === "completed"}
                            fallback={
                              <span
                                class="mt-1 size-3 shrink-0 rounded-full border border-border-weak-base"
                                aria-hidden="true"
                              />
                            }
                          >
                            <Icon name="check" size="small" />
                          </Show>
                          <span class="min-w-0 flex-1 break-words">{step.title}</span>
                          <span class="shrink-0 text-11-regular text-text-weak">{stepStatus(step.status)}</span>
                        </li>
                      )}
                    </For>
                  </ol>
                </>
              )}
            </Show>
          </section>
          <section class="pt-2" data-slot="task-progress-subtasks" aria-label={text("subtasks")}>
            <h3 class="flex items-center justify-between gap-2 px-2 py-1 text-12-medium">
              {text("subtasks")}
              <Show when={state.summary()}>
                {(summary) => (
                  <span class="text-text-weak">
                    {summary().items.length}
                    {summary().hasMore ? "+" : ""}
                  </span>
                )}
              </Show>
            </h3>
            <Show when={state.loading() && !state.summary()}>
              <p role="status" class="p-2 text-12-regular">
                {language.t("common.loading")}
              </p>
            </Show>
            <Show when={!state.summary() && !state.loading() && !state.failed()}>
              <p role="status" class="p-2 text-12-regular text-text-weak">
                {text("tasksPending")}
              </p>
            </Show>
            <Show when={state.failed()}>
              <p role="status" class="p-2 text-12-regular text-text-weak">
                {language.t("common.requestFailed")}
              </p>
            </Show>
            <For
              each={state.summary()?.items}
              fallback={
                <Show when={!!state.summary() && !state.loading() && !state.failed()}>
                  <p class="p-2 text-12-regular text-text-weak">{text("tasksEmpty")}</p>
                </Show>
              }
            >
              {(item) => (
                <button
                  type="button"
                  class="flex w-full min-w-0 items-center gap-2 rounded-md p-2 text-left hover:bg-surface-raised-base-hover"
                  onClick={() => select(item)}
                >
                  <Icon name="agent-tree" size="small" />
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-12-medium">{item.title}</span>
                    <span class="block text-11-regular text-text-weak">{taskLabel(item, text)}</span>
                  </span>
                  <Icon name="chevron-right" size="small" />
                </button>
              )}
            </For>
            <Show when={state.summary()?.hasMore}>
              <p class="p-2 text-11-regular text-text-weak">{text("tasksPartial")}</p>
            </Show>
          </section>
        </div>
      </Popover>
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
        {(item) => (
          <section class="mt-4 rounded-lg bg-surface-raised-base p-3 text-12-regular">
            <h4 class="text-13-medium">{item().title}</h4>
            <p class="mt-1 text-text-weak">{item().agent}</p>
            <Show when={item().state === "unknown"}>
              <p class="mt-1 text-text-weak">{text("taskState.unknown")}</p>
            </Show>
            <Show when={item().controlState === "close_requested"}>
              <p class="mt-2 text-text-warning">{text("taskState.close_requested")}</p>
            </Show>
            <Show when={item().progress?.text && item().progress?.text !== item().result.text}>
              <p class="mt-3 whitespace-pre-wrap break-words">{item().progress?.text}</p>
            </Show>
            <Show when={item().progress?.tool}>
              {(tool) => (
                <p class="mt-2 text-text-weak">
                  {tool().name} · {tool().status}
                </p>
              )}
            </Show>
            <p class="mt-3 text-text-weak">
              {text("result")}: {text(`resultState.${item().result.state}`)}
            </p>
            <Show when={item().result.text}>
              <p class="mt-2 whitespace-pre-wrap break-words">{item().result.text}</p>
            </Show>
            <Show when={item().result.truncated}>
              <p class="mt-1 text-text-weak">{text("resultTruncated")}</p>
            </Show>
            <p class="mt-3 text-text-weak">
              {text("notification")}: {text(`notificationState.${item().notification.state}`)}
            </p>
          </section>
        )}
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
