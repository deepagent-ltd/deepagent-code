import type { SessionContextDiagnosticsResponse } from "@deepagent-code/sdk"
import { Icon } from "@deepagent-code/ui/icon"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { Tooltip } from "@deepagent-code/ui/tooltip"
import { useParams } from "@solidjs/router"
import { For, Show, createMemo, createResource, createSignal, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"

type Diagnostics = SessionContextDiagnosticsResponse
type Selection = Diagnostics["selections"][number]
type Attempt = Diagnostics["attempts"][number]
type Status = Selection["statuses"][number]
type Graph = Status["graph"]

const graphs = ["code", "knowledge", "memory", "documents"] as const

export const SidePanelContext: Component<{ onClose: () => void }> = (props) => {
  const sdk = useSDK()
  const params = useParams()
  const language = useLanguage()
  const [reason, setReason] = createSignal("")
  const [riskAcknowledged, setRiskAcknowledged] = createSignal(false)
  const [resolving, setResolving] = createSignal<string>()
  const [diagnostics, { refetch }] = createResource(
    () => params.id,
    async (sessionID) => (await sdk.client.session.contextDiagnostics({ sessionID })).data,
  )
  const latest = createMemo(() => diagnostics()?.selections[0])
  const indeterminate = createMemo(() =>
    diagnostics()?.attempts.filter((attempt) => attempt.state === "indeterminate_after_crash") ?? [],
  )

  const resolve = async (attempt: Attempt, decision: "abandoned" | "settled" | "replayed") => {
    const value = reason().trim()
    if (!value || (decision === "replayed" && !riskAcknowledged())) return
    setResolving(attempt.attemptId)
    const result = await sdk.client.session.contextAttemptResolve({
      sessionID: params.id!,
      attemptID: attempt.attemptId,
      decision,
      reason: value,
      riskAcknowledged: decision === "replayed" ? true : undefined,
    })
    setResolving(undefined)
    if (result.error) {
      const { showToast } = await import("@/utils/toast")
      showToast({ variant: "error", title: language.t("session.context.resolveFailed") })
      return
    }
    setReason("")
    setRiskAcknowledged(false)
    await refetch()
  }

  return (
    <section class="size-full min-w-0 flex flex-col overflow-hidden bg-background-base">
      <header class="h-10 shrink-0 px-2 flex items-center gap-2 border-b border-border-weaker-base">
        <Icon name="shield" size="small" class="text-icon-base" />
        <div class="min-w-0 flex-1 text-13-medium text-text-strong truncate">
          {language.t("session.context.title")}
        </div>
        <IconButton
          icon="history"
          variant="ghost"
          class="h-7 w-7 rounded-md"
          onClick={() => void refetch()}
          aria-label={language.t("common.refresh")}
        />
        <IconButton
          icon="close-small"
          variant="ghost"
          class="h-7 w-7 rounded-md"
          onClick={props.onClose}
          aria-label={language.t("common.close")}
        />
      </header>

      <div class="flex-1 min-h-0 overflow-y-auto">
        <Show when={diagnostics.loading}>
          <div class="p-3 text-13-regular text-text-weak">
            {language.t("common.loading")}{language.t("common.loading.ellipsis")}
          </div>
        </Show>
        <Show when={diagnostics.error}>
          <div class="p-3 flex items-center justify-between gap-2 text-13-regular text-text-weak">
            <span>{language.t("session.context.loadFailed")}</span>
            <button class="text-12-medium text-text-info hover:underline" onClick={() => void refetch()}>
              {language.t("common.retry")}
            </button>
          </div>
        </Show>

        <Show when={!diagnostics.loading && !diagnostics.error && latest()} keyed>
          {(selection) => (
            <>
              <div class="px-3 py-2.5 border-b border-border-weaker-base">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-11-medium text-text-weak uppercase">{language.t("session.context.status")}</span>
                  <span class={summaryClass(selection.summary)}>
                    {language.t(`session.context.summary.${selection.summary}`)}
                  </span>
                </div>
                <div class="mt-2 divide-y divide-border-weaker-base">
                  <For each={graphs}>
                    {(graph) => (
                      <GraphStatus
                        graph={graph}
                        status={selection.statuses.find((status) => status.graph === graph)}
                        selection={selection}
                      />
                    )}
                  </For>
                </div>
              </div>

              <div class="px-3 py-2.5 border-b border-border-weaker-base">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-11-medium text-text-weak uppercase">{language.t("session.context.artifact")}</span>
                  <span class={artifactClass(selection.artifact.status)}>
                    {language.t(`session.context.artifact.${selection.artifact.status}`)}
                  </span>
                </div>
                <Show when={selection.artifact.status !== "available"}>
                  <div class="mt-1 text-11-regular text-text-weaker break-words">
                    {selection.artifact.status === "available" ? "" : selection.artifact.reasonCode}
                  </div>
                </Show>
              </div>

              <div class="border-b border-border-weaker-base">
                <div class="px-3 py-2 text-11-medium text-text-weak uppercase">
                  {language.t("session.context.evidence")} · {selection.evidence.length}
                </div>
                <Show
                  when={selection.evidence.length > 0}
                  fallback={<div class="px-3 pb-3 text-12-regular text-text-weaker">{language.t("session.context.noEvidence")}</div>}
                >
                  <For each={selection.evidence}>
                    {(evidence) => (
                      <div class="px-3 py-2 border-t border-border-weaker-base">
                        <div class="flex items-center gap-2">
                          <span class="text-11-medium text-text-strong">{graphLabel(evidence.graph)}</span>
                          <span class={freshnessClass(evidence.freshness)}>
                            {language.t(`session.context.state.${evidence.freshness}`)}
                          </span>
                          <span class="ml-auto text-10-regular text-text-weaker font-mono">
                            {evidence.score.toFixed(3)}
                          </span>
                          <Tooltip value={language.t("session.context.copyRef")} placement="left">
                            <IconButton
                              icon="copy"
                              variant="ghost"
                              class="h-6 w-6 rounded-md"
                              onClick={() => void navigator.clipboard.writeText(evidence.token)}
                              aria-label={language.t("session.context.copyRef")}
                            />
                          </Tooltip>
                        </div>
                        <div class="mt-1 text-11-regular text-text-weak break-words">{evidence.reason}</div>
                        <div class="mt-1 text-10-regular text-text-weaker font-mono truncate" title={evidence.token}>
                          {evidence.token}
                        </div>
                        <Show when={evidence.provenance.length > 0 || evidence.relations.length > 0}>
                          <div class="mt-1 text-10-regular text-text-weaker">
                            {language.t("session.context.provenance")} {evidence.provenance.length} · {language.t("session.context.relations")} {evidence.relations.length}
                            <Show when={evidence.relations.some((relation) => relation.freshness === "broken")}>
                              <span class="ml-2 text-text-critical">{language.t("session.context.state.broken")}</span>
                            </Show>
                          </div>
                        </Show>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </>
          )}
        </Show>

        <Show when={!diagnostics.loading && !diagnostics.error && !latest()}>
          <div class="p-3 text-13-regular text-text-weak">{language.t("session.context.noSelection")}</div>
        </Show>

        <Show when={indeterminate().length > 0}>
          <div class="px-3 py-2.5 border-b border-border-weaker-base bg-surface-raised-base">
            <div class="flex items-center gap-2 text-12-medium text-text-warning">
              <Icon name="warning" size="small" />
              {language.t("session.context.indeterminate")} · {indeterminate().length}
            </div>
            <input
              class="mt-2 w-full h-8 px-2 border border-border-weak-base bg-background-base text-12-regular text-text-strong outline-none focus:border-border-focus-base"
              value={reason()}
              onInput={(event) => setReason(event.currentTarget.value)}
              placeholder={language.t("session.context.reason")}
            />
            <label class="mt-2 flex items-start gap-2 text-11-regular text-text-weak">
              <input
                type="checkbox"
                checked={riskAcknowledged()}
                onChange={(event) => setRiskAcknowledged(event.currentTarget.checked)}
              />
              <span>{language.t("session.context.replayRisk")}</span>
            </label>
            <For each={indeterminate()}>
              {(attempt) => (
                <div class="mt-2 pt-2 border-t border-border-weak-base">
                  <div class="flex items-center gap-2 text-11-regular text-text-weak">
                    <span class="font-mono truncate">{attempt.attemptId}</span>
                    <span class="ml-auto shrink-0">{attempt.providerId}</span>
                  </div>
                  <div class="mt-2 flex items-center gap-1">
                    <Tooltip value={language.t("session.context.abandon")}>
                      <IconButton
                        icon="circle-x"
                        variant="ghost"
                        class="h-7 w-7 rounded-md"
                        disabled={!reason().trim() || resolving() === attempt.attemptId}
                        onClick={() => void resolve(attempt, "abandoned")}
                        aria-label={language.t("session.context.abandon")}
                      />
                    </Tooltip>
                    <Tooltip value={language.t("session.context.settle")}>
                      <IconButton
                        icon="circle-check"
                        variant="ghost"
                        class="h-7 w-7 rounded-md"
                        disabled={!attempt.canSettle || !reason().trim() || resolving() === attempt.attemptId}
                        onClick={() => void resolve(attempt, "settled")}
                        aria-label={language.t("session.context.settle")}
                      />
                    </Tooltip>
                    <Tooltip value={language.t("session.context.replay")}>
                      <IconButton
                        icon="history"
                        variant="ghost"
                        class="h-7 w-7 rounded-md"
                        disabled={!reason().trim() || !riskAcknowledged() || resolving() === attempt.attemptId}
                        onClick={() => void resolve(attempt, "replayed")}
                        aria-label={language.t("session.context.replay")}
                      />
                    </Tooltip>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={diagnostics()} keyed>
          {(value) => (
            <div class="px-3 py-2.5">
              <div class="text-11-medium text-text-weak uppercase">{language.t("session.context.metrics")}</div>
              <Show when={value.metrics.shadow.comparisons > 0}>
                <div class="mt-2 flex items-center gap-2 text-11-regular">
                  <span class="text-text-strong">{language.t("session.context.shadow")}</span>
                  <span class="text-text-weaker">{value.metrics.shadow.comparisons}</span>
                  <span class="ml-auto text-text-weaker font-mono">
                    {value.metrics.shadow.knowledgeMemoryDelta >= 0 ? "+" : ""}
                    {value.metrics.shadow.knowledgeMemoryDelta}
                  </span>
                </div>
              </Show>
              <div class="mt-2 divide-y divide-border-weaker-base">
                <For each={value.metrics.graphs}>
                  {(metric) => (
                    <div class="py-1.5 flex items-center gap-2 text-11-regular">
                      <span class="w-20 text-text-strong">{graphLabel(metric.graph)}</span>
                      <span class="text-text-weaker">{metric.candidates} / {metric.selected}</span>
                      <span class="ml-auto text-text-weaker font-mono">{Math.round(metric.lastLatencyMs)} ms</span>
                    </div>
                  )}
                </For>
              </div>
            </div>
          )}
        </Show>
      </div>
    </section>
  )

  function GraphStatus(input: { graph: Graph; status?: Status; selection: Selection }) {
    const state = () => displayState(input.graph, input.status, input.selection)
    return (
      <div class="py-1.5 flex items-center gap-2">
        <span class="w-20 text-12-medium text-text-strong">{graphLabel(input.graph)}</span>
        <span class={statusClass(state())}>{language.t(`session.context.state.${state()}`)}</span>
        <span class="ml-auto max-w-28 text-10-regular text-text-weaker font-mono truncate">
          {revisionLabel(input.status)}
        </span>
      </div>
    )
  }
}

function revisionLabel(status: Status | undefined) {
  const revision = status?.revisions[0]
  if (!revision || typeof revision !== "object") return "-"
  if ("revision" in revision && typeof revision.revision === "string") return revision.revision
  if ("state" in revision && typeof revision.state === "string") return revision.state
  return "-"
}

function displayState(graph: Graph, status: Status | undefined, selection: Selection) {
  const evidence = selection.evidence.filter((item) => item.graph === graph)
  if (evidence.some((item) => item.relations.some((relation) => relation.freshness === "broken"))) return "broken"
  if (evidence.some((item) => item.freshness === "conflict")) return "conflict"
  if (!status || status.kind === "not_queried") return "disabled"
  if (status.kind === "complete") return status.outcome === "empty" ? "empty" : "ready"
  return status.state
}

function graphLabel(graph: Graph) {
  if (graph === "code") return "Code"
  if (graph === "knowledge") return "Knowledge"
  if (graph === "memory") return "Memory"
  return "Documents"
}

function statusClass(state: string) {
  if (["ready", "empty"].includes(state)) return "text-11-medium text-text-success"
  if (["denied", "unavailable", "broken", "conflict"].includes(state)) return "text-11-medium text-text-critical"
  return "text-11-medium text-text-warning"
}

function freshnessClass(state: string) {
  return `${statusClass(state)} shrink-0`
}

function summaryClass(summary: Selection["summary"]) {
  return summary === "complete"
    ? "text-11-medium text-text-success"
    : summary === "empty"
      ? "text-11-medium text-text-weak"
      : "text-11-medium text-text-warning"
}

function artifactClass(status: Selection["artifact"]["status"]) {
  return status === "available"
    ? "text-11-medium text-text-success"
    : status === "expired"
      ? "text-11-medium text-text-weak"
      : "text-11-medium text-text-critical"
}
