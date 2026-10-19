import { createEffect, createMemo, onCleanup, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { Schema } from "effect"
import { Tooltip, type TooltipProps } from "@deepagent-code/ui/tooltip"
import { ProgressCircle } from "@deepagent-code/ui/progress-circle"
import { Popover } from "@deepagent-code/ui/popover"
import { Button } from "@deepagent-code/ui/button"
import { Icon } from "@deepagent-code/ui/icon"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { SessionContextUsageSchema } from "@deepagent-code/core/session/context-usage.schema"
import { checksum } from "@deepagent-code/core/util/encode"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useLocal } from "@/context/local"
import { usePrompt } from "@/context/prompt"
import { useLanguage } from "@/context/language"
import { useSessionLayout } from "@/pages/session/session-layout"
import { contextPercent, contextTokens, contextTokenTotal } from "./session/session-context-preview"

interface SessionContextUsageProps {
  variant?: "button" | "indicator"
  placement?: TooltipProps["placement"]
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function SessionContextUsage(props: SessionContextUsageProps) {
  const sync = useSync()
  const sdk = useSDK()
  const local = useLocal()
  const prompt = usePrompt()
  const language = useLanguage()
  const dialog = useDialog()
  const { params } = useSessionLayout()
  const [state, setState] = createStore({
    opened: false,
    triggerFocused: false,
    section: undefined as "activity" | "session" | "more" | undefined,
    summary: undefined as SessionContextUsageSchema.Summary | undefined,
    key: "",
    scope: "",
    toolRevision: 0,
    loading: false,
    failed: false,
  })
  const opened = () => props.open ?? state.opened
  const change = (value: boolean) => {
    if (props.open === undefined) setState("opened", value)
    props.onOpenChange?.(value)
  }
  const text = (key: string) => language.t(`context.preview.${key}` as Parameters<typeof language.t>[0])
  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const request = createMemo(() => {
    const model = local.model.current()
    const content = prompt.current()
    return {
      providerID: model?.provider.id,
      modelID: model?.id,
      variant: local.model.variant.current(),
      agent: local.agent.current()?.name,
      draft: content
        .filter((item) => item.type === "text")
        .map((item) => item.content)
        .join(""),
      draftRevision: checksum(JSON.stringify([content, prompt.context.items()])) ?? "empty",
      hasAttachments: content.some((item) => item.type !== "text") || prompt.context.items().length > 0,
    }
  })
  const identity = createMemo(() => JSON.stringify([sdk.scope, sdk.directory, params.id]))
  const busy = () =>
    !!params.id && !!sync.data.session_status?.[params.id] && sync.data.session_status[params.id].type !== "idle"
  const key = createMemo(() =>
    JSON.stringify([
      identity(),
      request(),
      local.model.current()?.limit,
      sync.data.config,
      sync.data.mcp,
      info()?.permission,
      state.toolRevision,
      busy(),
      info()?.time.updated,
      (params.id ? sync.data.message[params.id] : undefined)?.map((message) => [
        message.id,
        message.role === "assistant" ? message.finish : undefined,
      ]),
    ]),
  )
  createEffect(() => {
    const scope = identity()
    if (untrack(() => state.scope) === scope) return
    setState({ scope, summary: undefined, key: "", section: undefined, failed: false })
  })
  onCleanup(sdk.event.on("mcp.tools.changed", () => setState("toolRevision", (value) => value + 1)))
  const dirty = () => state.key !== key()
  const percent = createMemo(() => contextPercent(state.summary?.estimate, dirty() || state.failed || busy()))
  const tokens = (value: number | null | undefined) => contextTokens(value, language.intl())
  const capacity = () => (dirty() ? local.model.current()?.limit.context : state.summary?.estimate.contextLimit)
  const usageLabel = () => (percent() ? `${percent()!.used}%` : text("unknown"))
  let controller: AbortController | undefined
  let trigger: HTMLButtonElement | undefined
  const read = async () => {
    const sessionID = params.id
    if (!sessionID || document.visibilityState === "hidden") return
    controller?.abort()
    const current = new AbortController()
    controller = current
    const scopeKey = key()
    setState({ loading: true, failed: false })
    const result = await sdk.client.session
      .contextUsage(
        { sessionID, ...request() },
        {
          signal: AbortSignal.any([current.signal, AbortSignal.timeout(10_000)]),
        },
      )
      .then((response) => Schema.decodeUnknownSync(SessionContextUsageSchema.Summary)(response.data))
      .catch(() => undefined)
    if (current.signal.aborted || key() !== scopeKey) return
    if (!result || result.sessionID !== sessionID || result.estimate.draftRevision !== request().draftRevision) {
      setState({ loading: false, failed: true })
      return
    }
    setState({ summary: result, key: scopeKey, loading: false, failed: false })
  }
  createEffect(() => {
    key()
    controller?.abort()
    setState("loading", false)
    const timer = setTimeout(() => void read(), 400)
    onCleanup(() => clearTimeout(timer))
  })
  createEffect(() => {
    if (!opened()) return
    if (untrack(dirty) || !untrack(() => state.summary)) void read()
  })
  const visible = () => {
    if (document.visibilityState === "hidden") {
      controller?.abort()
      setState("loading", false)
      return
    }
    if (dirty() || !state.summary) void read()
  }
  document.addEventListener("visibilitychange", visible)
  onCleanup(() => {
    controller?.abort()
    document.removeEventListener("visibilitychange", visible)
  })
  const headline = () => (
    <div class="flex flex-col items-center gap-1 text-center" data-component="context-usage-summary">
      <div class="text-14-regular text-text-weak">{text("title")}</div>
      <div class="text-16-regular text-text-strong">
        <Show
          when={percent()}
          fallback={
            busy()
              ? text("generating")
              : state.failed
                ? text("readFailed")
                : state.loading || dirty()
                  ? text("refreshRequired")
                  : text("incomplete")
          }
        >
          {(value) => (
            <>
              {value().used}% {text("used")}（{text("remaining")} {value().remaining}%）
              {value().over ? ` · ${text("over")}` : ""}
            </>
          )}
        </Show>
      </div>
      <div class="text-14-regular text-text-base">
        {text("used")} {dirty() ? "—" : `≈${tokens(state.summary?.estimate.inputTokens)}`}，{text("capacity")}{" "}
        {tokens(capacity())}
      </div>
    </div>
  )
  const breakdown = (
    value: SessionContextUsageSchema.Tokens,
    reported: { reasoning: boolean; cacheRead: boolean; cacheWrite: boolean },
  ) => (
    <>
      <dl class="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-12-regular">
        <dt>{text("nonCachedInput")}</dt>
        <dd>≈{tokens(value.nonCachedInput)}</dd>
        <dt>{text("cacheRead")}</dt>
        <dd>{reported.cacheRead ? `≈${tokens(value.cacheRead)}` : "—"}</dd>
        <dt>{text("cacheWrite")}</dt>
        <dd>{reported.cacheWrite ? `≈${tokens(value.cacheWrite)}` : "—"}</dd>
        <dt>{text("output")}</dt>
        <dd>≈{tokens(value.output + value.reasoning)}</dd>
        <dt class="pl-2 text-text-weak">{text("reasoningSubset")}</dt>
        <dd>{reported.reasoning ? `≈${tokens(value.reasoning)}` : "—"}</dd>
      </dl>
      <Show when={!reported.reasoning || !reported.cacheRead || !reported.cacheWrite}>
        <p class="pt-2 text-12-regular text-text-weak">{text("fieldUnknown")}</p>
      </Show>
    </>
  )
  const section = (name: "activity" | "session" | "more") =>
    setState("section", state.section === name ? undefined : name)
  const more = async () => {
    const sessionID = params.id
    const scope = identity()
    const component = await import("@/components/session-context-dialog")
    if (params.id !== sessionID || identity() !== scope || !opened()) return
    change(false)
    trigger?.focus()
    dialog.show(() => <component.SessionContextUsageDialog />)
  }
  return (
    <Show when={params.id}>
      <Tooltip
        value={headline()}
        placement={props.placement ?? "top"}
        class="inline-flex"
        forceOpen={state.triggerFocused && !opened()}
      >
        <Popover
          open={opened()}
          onOpenChange={change}
          placement="bottom-end"
          class="rounded-2xl bg-surface-raised-base shadow-xl"
          style={{ width: "360px", "max-width": "calc(100vw - 24px)", "border-radius": "20px" }}
          title={<span class="sr-only">{text("title")}</span>}
          triggerAs="button"
          triggerProps={{
            type: "button",
            onFocus: (event) => {
              trigger = event.currentTarget
              setState("triggerFocused", true)
            },
            onPointerDown: (event) => {
              trigger = event.currentTarget
            },
            onClick: (event) => {
              trigger = event.currentTarget
            },
            onBlur: () => setState("triggerFocused", false),
            class:
              "size-8 rounded-lg inline-flex items-center justify-center text-text-base hover:bg-surface-raised-base focus-visible:outline-2 focus-visible:outline-border-strong-base max-sm:min-h-11 max-sm:min-w-11",
            "aria-label": language.t("context.usage.view"),
          }}
          trigger={
            <span
              class="inline-flex items-center justify-center"
              role="img"
              aria-label={`${text("title")} ${usageLabel()}`}
            >
              <Show
                when={percent()}
                fallback={
                  <span
                    class="size-[18px] rounded-full border-2 border-border-strong-base"
                    data-slot="context-usage-unknown"
                  />
                }
              >
                {(value) => <ProgressCircle size={18} strokeWidth={2} percentage={value().raw} />}
              </Show>
            </span>
          }
        >
          <div
            class="flex max-h-[min(560px,70vh)] flex-col gap-4 overflow-y-auto p-1"
            data-component="context-usage-card"
          >
            {headline()}
            <Show when={state.summary?.estimate.status !== "complete" || dirty()}>
              <p class="text-12-regular text-text-weak">
                {dirty() ? text("refreshRequired") : text("incompleteExplanation")}
              </p>
            </Show>
            <Button variant="ghost" size="small" disabled={state.loading} onClick={() => void read()}>
              {text("refresh")}
            </Button>
            <div class="rounded-xl bg-surface-base p-3">
              <button
                type="button"
                class="flex w-full items-center justify-between gap-3 text-14-regular"
                aria-expanded={state.section === "activity"}
                onClick={() => section("activity")}
              >
                <span>{state.summary?.activity?.current ? text("currentActivity") : text("lastActivity")}</span>
                <span>
                  {state.summary?.activity ? `≈${tokens(contextTokenTotal(state.summary!.activity!.tokens))}` : "—"}
                </span>
              </button>
              <p class="mt-1 text-12-regular text-text-weak">
                {state.summary?.activity
                  ? `${state.summary.activity.calls} ${text("calls")} · ${text(`state.${state.summary.activity.state}`)}`
                  : text("noActivity")}
                {state.summary?.activity?.unknownCalls ? ` · ${text("reportedPartial")}` : ""}
              </p>
              <Show when={state.section === "activity" && state.summary?.activity}>
                <div class="pt-3">
                  {breakdown(state.summary!.activity!.tokens, {
                    reasoning: state.summary!.activity!.reasoningReported,
                    cacheRead: state.summary!.activity!.cacheReadReported,
                    cacheWrite: state.summary!.activity!.cacheWriteReported,
                  })}
                </div>
                <Show when={!state.summary?.activity?.reasoningReported}>
                  <p class="pt-2 text-12-regular text-text-weak">{text("reasoningUnknown")}</p>
                </Show>
              </Show>
            </div>
            <div class="rounded-xl bg-surface-base p-3">
              <button
                type="button"
                class="flex w-full items-center justify-between gap-3 text-14-regular"
                aria-expanded={state.section === "session"}
                onClick={() => section("session")}
              >
                <span>{text("sessionTotal")}</span>
                <span>{state.summary ? `≈${tokens(contextTokenTotal(state.summary.totals))}` : "—"}</span>
              </button>
              <p class="mt-1 text-12-regular text-text-weak">
                {text("recordedOnly")}
                {state.summary?.coverage === "partial" ? ` · ${text("reportedPartial")}` : ""}
              </p>
              <Show when={state.section === "session" && state.summary}>
                <div class="pt-3">
                  {breakdown(state.summary!.totals, {
                    reasoning: state.summary!.totalsReasoningReported,
                    cacheRead: state.summary!.totalsCacheReadReported,
                    cacheWrite: state.summary!.totalsCacheWriteReported,
                  })}
                </div>
              </Show>
            </div>
            <button
              type="button"
              class="flex items-center justify-between text-12-regular text-text-weak"
              aria-expanded={state.section === "more"}
              onClick={() => section("more")}
            >
              {text("explanation")}
              <Icon name="chevron-down" size="small" />
            </button>
            <Show when={state.section === "more"}>
              <div class="flex flex-col gap-2 text-12-regular text-text-weak">
                <p>{text("estimateExplanation")}</p>
                <Show when={state.summary?.estimate.missing.length}>
                  <p>
                    {text("notIncluded")}:{" "}
                    {state.summary?.estimate.missing.map((reason) => text(`missing.${reason}`)).join(", ")}
                  </p>
                </Show>
                <p>
                  {text("capacity")}: {tokens(capacity())} · {text("inputBudget")}:{" "}
                  {tokens(state.summary?.estimate.physicalInputBudget)}
                </p>
                <Button variant="ghost" size="small" onClick={() => void more()}>
                  {text("moreUsage")}
                </Button>
              </div>
            </Show>
          </div>
        </Popover>
      </Tooltip>
    </Show>
  )
}
