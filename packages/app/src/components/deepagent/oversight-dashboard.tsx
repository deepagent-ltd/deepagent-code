import { createResource, createSignal, For, Show, type Component } from "solid-js"
import { Button } from "@deepagent-code/ui/button"
import { Spinner } from "@deepagent-code/ui/spinner"
import { useSDK } from "@/context/sdk"
import {
  fetchOversightApprovals,
  fetchOversightMetrics,
  fetchOversightTrace,
  recordHumanTakeover,
  recordRollback,
  resolveOversightApproval,
  type OversightApprovalDecision,
  type OversightApprovalItem,
  type OversightClient,
  type OversightMetrics,
  type OversightTraceNode,
} from "./oversight.api"

// V4.0 §D2 — the Oversight Dashboard. Three read-mostly surfaces backed by the durable V4 substrate:
//   1. Agent Dashboard — §F1 metrics (success/conflict/DLQ/push-rejected/latency + human-takeover).
//   2. Approval Queue — §D2 pending human-decision items + a resolve action.
//   3. Event Trace — §F2 causal event chain for a correlationID.
// Plus a §D2 human-takeover control (activates once P3.10's endpoint lands; tolerated absent here).
// Rendered inside the session right-side-panel (see side-panel-oversight.tsx), so it owns only its
// body + section chrome, matching SidePanelIM.

const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`)
const ms = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v)}ms`)
const num = (v: number | null | undefined) => (v == null ? "—" : String(v))

function fmtTime(epochMs: number) {
  try {
    return new Date(epochMs).toLocaleString()
  } catch {
    return String(epochMs)
  }
}

// ── metric card ─────────────────────────────────────────────────────────────
function MetricCard(props: { label: string; value: string; tone?: "ok" | "warn" | "bad" | "neutral" }) {
  const toneClass =
    props.tone === "ok"
      ? "text-icon-success-base"
      : props.tone === "warn"
        ? "text-icon-warning-base"
        : props.tone === "bad"
          ? "text-icon-critical-base"
          : "text-text-strong"
  return (
    <div class="rounded-lg border border-border-weak-base bg-surface-base px-3 py-2.5">
      <div class="text-11-regular text-text-weak truncate">{props.label}</div>
      <div class={`mt-1 text-18-medium tabular-nums ${toneClass}`}>{props.value}</div>
    </div>
  )
}

export const OversightDashboard: Component = () => {
  const sdk = useSDK()
  const client = () => sdk.client as unknown as OversightClient

  // ── §F1 metrics ─────────────────────────────────────────────────────────────
  const [metricsVersion, setMetricsVersion] = createSignal(0)
  const [metrics, { refetch: refetchMetrics }] = createResource<OversightMetrics | undefined, number>(
    metricsVersion,
    () => fetchOversightMetrics(client()),
  )

  // ── §D2 approval queue ────────────────────────────────────────────────────────
  const [approvalsVersion, setApprovalsVersion] = createSignal(0)
  const [approvals, { refetch: refetchApprovals }] = createResource<OversightApprovalItem[], number>(
    approvalsVersion,
    () => fetchOversightApprovals(client()),
  )
  const [resolvingId, setResolvingId] = createSignal<string | null>(null)

  const resolve = async (item: OversightApprovalItem, decision: OversightApprovalDecision) => {
    setResolvingId(item.id)
    try {
      await resolveOversightApproval(client(), { id: item.id, decision })
      await refetchApprovals()
    } catch (error) {
      const { showToast } = await import("@/utils/toast")
      showToast({
        variant: "error",
        title: "Failed to resolve",
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setResolvingId(null)
    }
  }

  // ── §F2 trace ─────────────────────────────────────────────────────────────────
  const [traceQuery, setTraceQuery] = createSignal("")
  const [traceInput, setTraceInput] = createSignal("")
  const [traceResource, { refetch: refetchTrace }] = createResource<OversightTraceNode[], string>(
    () => traceQuery() || undefined,
    (correlationID) => fetchOversightTrace(client(), correlationID),
  )
  const trace = () => traceResource() ?? []

  const runTrace = () => {
    const q = traceInput().trim()
    if (!q) return
    if (q === traceQuery()) void refetchTrace()
    else setTraceQuery(q)
  }

  // ── §D2 human takeover (P3.10) ─────────────────────────────────────────────────
  const [takeoverReason, setTakeoverReason] = createSignal("")
  const [takeoverBusy, setTakeoverBusy] = createSignal(false)
  const [takeoverNote, setTakeoverNote] = createSignal<string | null>(null)

  const submitTakeover = async () => {
    const reason = takeoverReason().trim()
    if (!reason) return
    setTakeoverBusy(true)
    setTakeoverNote(null)
    const result = await recordHumanTakeover(client(), { reason })
    setTakeoverBusy(false)
    if (result.ok) {
      setTakeoverReason("")
      setTakeoverNote("Takeover recorded.")
      // A takeover bumps the human_takeover_total metric — refresh the dashboard.
      await refetchMetrics()
    } else if (result.unsupported) {
      setTakeoverNote("Takeover recording activates once the backend endpoint (P3.10) is available.")
    } else {
      setTakeoverNote(`Failed: ${result.error}`)
    }
  }

  // ── §D2 rollback (P4.4) ─────────────────────────────────────────────────────────
  const [rollbackSession, setRollbackSession] = createSignal("")
  const [rollbackReason, setRollbackReason] = createSignal("")
  const [rollbackBusy, setRollbackBusy] = createSignal(false)
  const [rollbackNote, setRollbackNote] = createSignal<string | null>(null)

  const submitRollback = async () => {
    const sessionID = rollbackSession().trim()
    if (!sessionID) return
    const reason = rollbackReason().trim()
    setRollbackBusy(true)
    setRollbackNote(null)
    const result = await recordRollback(client(), { sessionID, ...(reason ? { reason } : {}) })
    setRollbackBusy(false)
    if (result.ok) {
      setRollbackSession("")
      setRollbackReason("")
      setRollbackNote(
        result.record?.outcome === "noop"
          ? "Nothing to revert — rollback recorded as a no-op."
          : "Rollback applied — session reverted.",
      )
      // A rollback bumps the rollback_total metric — refresh the dashboard.
      await refetchMetrics()
    } else if (result.notFound) {
      setRollbackNote("No such session in this workspace.")
    } else {
      setRollbackNote(`Failed: ${result.error}`)
    }
  }

  return (
    <div class="flex-1 min-h-0 overflow-y-auto bg-background-base">
      <div class="flex flex-col gap-5 p-4">
        {/* ── Agent Dashboard (§F1) ── */}
        <section>
          <div class="mb-2 flex items-center justify-between">
            <h3 class="text-13-medium text-text-strong">Agent Dashboard</h3>
            <Button variant="secondary" size="small" icon="reset" onClick={() => setMetricsVersion((v) => v + 1)}>
              Refresh
            </Button>
          </div>
          <Show
            when={!metrics.loading}
            fallback={
              <div class="flex items-center gap-2 py-4 text-12-regular text-text-weak">
                <Spinner /> Loading metrics…
              </div>
            }
          >
            <Show
              when={metrics()}
              fallback={<div class="py-4 text-12-regular text-text-weak">No metrics available.</div>}
            >
              {(m) => (
                <>
                  <div class="grid grid-cols-2 gap-2">
                    <MetricCard
                      label="Task success rate"
                      value={pct(m().agentTaskSuccessRate)}
                      tone={
                        m().agentTaskSuccessRate == null
                          ? "neutral"
                          : m().agentTaskSuccessRate! >= 0.8
                            ? "ok"
                            : m().agentTaskSuccessRate! >= 0.5
                              ? "warn"
                              : "bad"
                      }
                    />
                    <MetricCard
                      label="Conflict rate"
                      value={pct(m().agentConflictRate)}
                      tone={
                        m().agentConflictRate == null
                          ? "neutral"
                          : m().agentConflictRate! <= 0.1
                            ? "ok"
                            : m().agentConflictRate! <= 0.3
                              ? "warn"
                              : "bad"
                      }
                    />
                    <MetricCard
                      label="DLQ events"
                      value={num(m().dlqEventsTotal)}
                      tone={m().dlqEventsTotal > 0 ? "warn" : "ok"}
                    />
                    <MetricCard
                      label="Push rejected"
                      value={num(m().agentPushRejectedTotal)}
                      tone={m().agentPushRejectedTotal > 0 ? "warn" : "ok"}
                    />
                    <MetricCard label="Tasks completed" value={num(m().agentTaskCompleted)} />
                    <MetricCard label="Tasks failed" value={num(m().agentTaskFailed)} tone={m().agentTaskFailed > 0 ? "warn" : "neutral"} />
                    <MetricCard label="Publish latency P50" value={ms(m().eventPublishLatencyMsP50)} />
                    <MetricCard label="Publish latency P95" value={ms(m().eventPublishLatencyMsP95)} />
                    <MetricCard label="Event→agent P50" value={ms(m().eventToAgentStartMsP50)} />
                    <MetricCard label="Event→agent P95" value={ms(m().eventToAgentStartMsP95)} />
                    {/* P3.10 — only rendered when the server reports it. */}
                    <Show when={m().humanTakeoverTotal != null}>
                      <MetricCard label="Human takeovers" value={num(m().humanTakeoverTotal)} tone="neutral" />
                    </Show>
                    {/* P4.4 — only rendered when the server reports it. */}
                    <Show when={m().rollbackTotal != null}>
                      <MetricCard label="Rollbacks" value={num(m().rollbackTotal)} tone="neutral" />
                    </Show>
                  </div>

                  {/* push-rejected breakdown by reason */}
                  <Show when={Object.keys(m().agentPushRejectedByReason ?? {}).length > 0}>
                    <div class="mt-2 rounded-lg border border-border-weak-base bg-surface-base px-3 py-2">
                      <div class="text-11-regular text-text-weak mb-1">Push rejected by reason</div>
                      <For each={Object.entries(m().agentPushRejectedByReason)}>
                        {([reason, count]) => (
                          <div class="flex items-center justify-between py-0.5 text-12-regular">
                            <span class="text-text-base font-mono truncate">{reason}</span>
                            <span class="text-text-strong tabular-nums">{count}</span>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>

                  <div class="mt-1.5 text-11-regular text-text-weaker">
                    Window: {fmtTime(m().windowFrom)} → {fmtTime(m().windowTo)}
                  </div>
                </>
              )}
            </Show>
          </Show>
        </section>

        <ApprovalQueueSection
          approvals={approvals}
          resolvingId={resolvingId}
          onResolve={resolve}
          onRefresh={() => setApprovalsVersion((v) => v + 1)}
          onTrace={(correlationID) => {
            setTraceInput(correlationID)
            setTraceQuery(correlationID)
          }}
        />

        {/* ── Event Trace (§F2) ── */}
        <section>
          <h3 class="mb-2 text-13-medium text-text-strong">Event Trace</h3>
          <div class="flex items-center gap-2">
            <input
              class="flex-1 min-w-0 rounded-md border border-border-weak-base bg-surface-base px-2 py-1 text-12-regular text-text-strong outline-none focus:ring-2 focus:ring-accent-base"
              placeholder="correlationID…"
              value={traceInput()}
              onInput={(e) => setTraceInput(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") runTrace()
              }}
            />
            <Button variant="secondary" size="small" onClick={runTrace} disabled={!traceInput().trim()}>
              Trace
            </Button>
          </div>
          <Show when={traceQuery()}>
            <Show
              when={!traceResource.loading}
              fallback={
                <div class="flex items-center gap-2 py-3 text-12-regular text-text-weak">
                  <Spinner /> Loading trace…
                </div>
              }
            >
              <Show
                when={trace().length > 0}
                fallback={<div class="py-3 text-12-regular text-text-weak">No events for this correlationID.</div>}
              >
                <div class="mt-2 flex flex-col">
                  <For each={trace()}>
                    {(node, index) => (
                      <div class="relative flex gap-2 pb-3">
                        {/* spine connector */}
                        <div class="flex flex-col items-center">
                          <div class="mt-1 h-2 w-2 shrink-0 rounded-full bg-icon-accent-base" />
                          <Show when={index() < trace().length - 1}>
                            <div class="mt-0.5 w-px flex-1 bg-border-weak-base" />
                          </Show>
                        </div>
                        <div class="min-w-0 flex-1">
                          <div class="text-12-medium text-text-strong font-mono truncate">{node.type}</div>
                          <div class="text-11-regular text-text-weak truncate">
                            source: <span class="font-mono">{node.source}</span>
                          </div>
                          <Show when={node.causationID}>
                            <div class="text-11-regular text-text-weaker truncate">
                              caused by: <span class="font-mono">{node.causationID}</span>
                            </div>
                          </Show>
                          <div class="text-11-regular text-text-weaker">{fmtTime(node.createdAt)}</div>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </Show>
        </section>

        {/* ── Human Takeover (§D2) ── */}
        <section>
          <h3 class="mb-1 text-13-medium text-text-strong">Human Takeover</h3>
          <p class="mb-2 text-11-regular text-text-weak">
            Record that a human is taking over from the autonomous agents (pauses autonomy escalation).
          </p>
          <textarea
            class="w-full rounded-md border border-border-weak-base bg-surface-base px-2 py-1.5 text-12-regular text-text-strong outline-none resize-none focus:ring-2 focus:ring-accent-base"
            rows={2}
            placeholder="Reason for taking over…"
            value={takeoverReason()}
            onInput={(e) => setTakeoverReason(e.currentTarget.value)}
          />
          <div class="mt-2 flex items-center gap-2">
            <Button
              variant="primary"
              size="small"
              icon="shield"
              onClick={submitTakeover}
              disabled={takeoverBusy() || !takeoverReason().trim()}
            >
              <Show when={takeoverBusy()}>
                <Spinner />
              </Show>
              Take over
            </Button>
            <Show when={takeoverNote()}>
              <span class="text-11-regular text-text-weak">{takeoverNote()}</span>
            </Show>
          </div>
        </section>

        {/* ── Rollback (§D2) ── */}
        <section>
          <h3 class="mb-1 text-13-medium text-text-strong">Rollback</h3>
          <p class="mb-2 text-11-regular text-text-weak">
            Revert an agent-produced change over a session (via SessionRevert). Only affects a session in
            this workspace. This reverts real changes — use with care.
          </p>
          <input
            class="w-full rounded-md border border-border-weak-base bg-surface-base px-2 py-1.5 text-12-regular text-text-strong outline-none focus:ring-2 focus:ring-accent-base font-mono"
            placeholder="Session ID (ses_…)"
            value={rollbackSession()}
            onInput={(e) => setRollbackSession(e.currentTarget.value)}
          />
          <textarea
            class="mt-2 w-full rounded-md border border-border-weak-base bg-surface-base px-2 py-1.5 text-12-regular text-text-strong outline-none resize-none focus:ring-2 focus:ring-accent-base"
            rows={2}
            placeholder="Reason for rolling back… (optional)"
            value={rollbackReason()}
            onInput={(e) => setRollbackReason(e.currentTarget.value)}
          />
          <div class="mt-2 flex items-center gap-2">
            <Button
              variant="primary"
              size="small"
              icon="reset"
              onClick={submitRollback}
              disabled={rollbackBusy() || !rollbackSession().trim()}
            >
              <Show when={rollbackBusy()}>
                <Spinner />
              </Show>
              Roll back
            </Button>
            <Show when={rollbackNote()}>
              <span class="text-11-regular text-text-weak">{rollbackNote()}</span>
            </Show>
          </div>
        </section>
      </div>
    </div>
  )
}

// ── Approval Queue (§D2) ────────────────────────────────────────────────────────
function ApprovalQueueSection(props: {
  approvals: () => OversightApprovalItem[] | undefined
  resolvingId: () => string | null
  onResolve: (item: OversightApprovalItem, decision: OversightApprovalDecision) => void
  onRefresh: () => void
  onTrace: (correlationID: string) => void
}) {
  const items = () => props.approvals() ?? []
  return (
    <section>
      <div class="mb-2 flex items-center justify-between">
        <h3 class="text-13-medium text-text-strong">
          Approval Queue
          <Show when={items().length > 0}>
            <span class="ml-1.5 rounded-full bg-surface-raised-base px-1.5 py-0.5 text-11-medium text-text-base">
              {items().length}
            </span>
          </Show>
        </h3>
        <Button variant="secondary" size="small" icon="reset" onClick={props.onRefresh}>
          Refresh
        </Button>
      </div>
      <Show
        when={items().length > 0}
        fallback={<div class="py-3 text-12-regular text-text-weak">No pending approvals.</div>}
      >
        <div class="flex flex-col gap-2">
          <For each={items()}>
            {(item) => (
              <div class="rounded-lg border border-border-weak-base bg-surface-base px-3 py-2.5">
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0">
                    <div class="text-12-medium text-text-strong">{item.summary}</div>
                    <div class="mt-0.5 text-11-regular text-text-weak font-mono truncate">{item.eventType}</div>
                  </div>
                  <span class="shrink-0 text-11-regular text-text-weaker">{fmtTime(item.createdAt)}</span>
                </div>
                <div class="mt-2 flex items-center gap-1.5">
                  <Button
                    variant="primary"
                    size="small"
                    disabled={props.resolvingId() === item.id}
                    onClick={() => props.onResolve(item, "approved")}
                  >
                    Approve
                  </Button>
                  <Button
                    variant="secondary"
                    size="small"
                    disabled={props.resolvingId() === item.id}
                    onClick={() => props.onResolve(item, "rejected")}
                  >
                    Reject
                  </Button>
                  <Button
                    variant="ghost"
                    size="small"
                    disabled={props.resolvingId() === item.id}
                    onClick={() => props.onResolve(item, "acknowledged")}
                  >
                    Acknowledge
                  </Button>
                  <Show when={item.correlationID}>
                    <button
                      type="button"
                      class="ml-auto text-11-regular text-text-link hover:underline"
                      onClick={() => props.onTrace(item.correlationID!)}
                    >
                      View trace
                    </button>
                  </Show>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  )
}
