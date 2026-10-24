import { createEffect, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@deepagent-code/ui/icon"
import type { SharedBrowserSchema } from "@deepagent-code/core/browser/shared-schema"
import { useLanguage } from "@/context/language"

export type BrowserOwnershipState = SharedBrowserSchema.Resource["state"]

export type BrowserControlPillProps = {
  resourceID: string
  ownershipEpoch: number
  state: BrowserOwnershipState
  /** Main's observed Agent-control duration, never the component's mount time. */
  elapsedMs?: number
  error?: string
  onTakeover?: () => Promise<void>
  onRetryTakeover?: () => Promise<void>
  onReturnToSession?: () => void
  onCloseResource?: () => void
}

export function BrowserControlPill(props: BrowserControlPillProps) {
  const language = useLanguage()
  const [state, setState] = createStore({ busy: false, error: "", elapsedMs: props.elapsedMs })
  const agent = () => props.state === "agent_owned"
  const blocked = () => props.state === "fenced_blocked" || props.state === "recovery_required"
  const canTakeover = () => agent() || props.state === "acquire_pending"
  const hasAction = () =>
    canTakeover() || blocked() || props.state === "takeover_pending" || props.state === "human_owned"
  const action = () => (props.state === "human_owned" ? "returnToSession" : blocked() ? "retryTakeover" : "takeover")
  const text = (key: string) => language.t(`browser.shared.${key}` as Parameters<typeof language.t>[0])
  let disposed = false
  onCleanup(() => {
    disposed = true
  })

  createEffect(() => {
    props.resourceID
    props.ownershipEpoch
    const duration = props.elapsedMs
    const running = agent()
    setState("elapsedMs", duration)
    if (!running || duration === undefined || !Number.isFinite(duration) || duration < 0) return
    const observedAt = performance.now()
    const timer = setInterval(() => setState("elapsedMs", duration + Math.max(0, performance.now() - observedAt)), 1000)
    onCleanup(() => clearInterval(timer))
  })
  createEffect(() => {
    props.resourceID
    props.ownershipEpoch
    props.state
    setState({ error: "", busy: false })
  })

  const elapsed = () => {
    const value = state.elapsedMs
    if (value === undefined || !Number.isFinite(value) || value < 0) return "—"
    const seconds = Math.floor(value / 1000)
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
  }
  const takeover = async () => {
    const operation = blocked() ? props.onRetryTakeover : canTakeover() ? props.onTakeover : undefined
    if (state.busy || !operation) return
    const resourceID = props.resourceID
    const ownershipEpoch = props.ownershipEpoch
    const ownership = props.state
    const current = () =>
      !disposed &&
      props.resourceID === resourceID &&
      props.ownershipEpoch === ownershipEpoch &&
      props.state === ownership
    setState({ busy: true, error: "" })
    try {
      await operation()
    } catch (error) {
      if (current()) setState("error", error instanceof Error ? error.message : text("requestFailed"))
    } finally {
      if (current()) setState("busy", false)
    }
  }

  return (
    <div
      class="flex max-w-full flex-col items-center gap-2"
      data-component="browser-control-pill"
      data-state={props.state}
    >
      <div
        role="group"
        aria-label={text("control")}
        class="inline-flex max-w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-full border border-border-base bg-surface-raised-stronger-non-alpha py-1.5 pl-4 pr-1.5 text-text-strong shadow-[var(--shadow-lg-border-base)]"
      >
        <div class="flex min-w-24 flex-1 items-center gap-2">
          <span
            aria-hidden="true"
            class="size-2 shrink-0 rounded-full bg-current"
            classList={{ "text-icon-success-base": agent(), "text-icon-warning-base": blocked() }}
          />
          <div class="flex min-w-0 flex-col gap-0.5">
            <span role="status" aria-live="polite" class="break-words text-12-medium">
              {text(props.state)}
            </span>
            <Show when={agent()}>
              <span
                role="timer"
                aria-live="off"
                aria-label={text("elapsed")}
                class="text-12-regular tabular-nums text-text-weak"
              >
                {elapsed()}
              </span>
            </Show>
          </div>
        </div>
        <Show when={hasAction()}>
          <span aria-hidden="true" class="h-4 w-px shrink-0 bg-border-base" />
          <button
            type="button"
            class="flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-12-medium transition-colors hover:bg-surface-raised-base-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-50"
            disabled={
              state.busy ||
              (props.state === "human_owned"
                ? !props.onReturnToSession
                : blocked()
                  ? !props.onRetryTakeover
                  : !canTakeover() || !props.onTakeover)
            }
            aria-busy={state.busy || props.state === "takeover_pending"}
            onClick={() => (props.state === "human_owned" ? props.onReturnToSession?.() : void takeover())}
          >
            <Show when={props.state !== "human_owned"} fallback={<Icon name="arrow-left" size="small" />}>
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path
                  d="M6.5 10V4.8a1 1 0 0 1 2 0V9M8.5 8.5V3.8a1 1 0 0 1 2 0V9M10.5 8.5V4.5a1 1 0 0 1 2 0V9.7M12.5 8.8V6.3a1 1 0 0 1 2 0V12c0 3.2-1.8 5-4.3 5H9.6c-1.5 0-2.6-.8-3.5-2.1l-2.5-3.6a1.1 1.1 0 0 1 1.7-1.4L6.5 11"
                  stroke="currentColor"
                  stroke-width="1.25"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </Show>
            {text(state.busy || props.state === "takeover_pending" ? "requesting" : action())}
          </button>
        </Show>
        <Show when={blocked() && props.onCloseResource}>
          <button
            type="button"
            aria-label={text("close")}
            onClick={() => props.onCloseResource?.()}
            class="flex size-8 shrink-0 items-center justify-center rounded-full hover:bg-surface-raised-base-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <Icon name="close-small" size="small" />
          </button>
        </Show>
      </div>
      <Show when={props.state === "human_owned"}>
        <p class="max-w-sm text-center text-12-regular text-text-weak">{text("humanHint")}</p>
      </Show>
      <Show when={props.error || state.error}>
        {(error) => (
          <p role="alert" class="max-w-sm text-center text-12-regular text-text-danger-base">
            {error()}
          </p>
        )}
      </Show>
    </div>
  )
}
