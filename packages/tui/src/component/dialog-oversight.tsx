import { createResource, createSignal, onMount } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogAlert } from "../ui/dialog-alert"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useSDK } from "../context/sdk"
import { useTuiI18n } from "../context/i18n"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

// Oversight TUI face — the §D2/§F surfaces the GUI dashboard owns (approval queue + metrics +
// trace + human-takeover + rollback). All routes are path-served instance-API paths (NOT in the
// generated SDK), hence the rawRequest escape hatch — same contract as the GUI oversight.api.ts.
// The server resolves the workspace from the directory routing the SDK client already injects.

type ApprovalItem = {
  id: string
  eventType: string
  summary: string
  status: "pending" | "resolved"
  correlationID?: string
  createdAt: number
}

type Metrics = {
  windowFrom: number
  windowTo: number
  dlqEventsTotal: number
  agentPushRejectedTotal: number
  agentTaskSuccessRate: number | null
  agentTaskCompleted: number
  agentTaskFailed: number
  agentConflictRate: number | null
  agentTaskBlockedTotal: number
  agentPushTotal: number
  humanTakeoverTotal?: number | null
  rollbackTotal?: number | null
}

type TraceNode = {
  eventID: string
  type: string
  source: string
  causationID?: string
  createdAt: number
}

const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`)
const num = (v: number | null | undefined) => (v == null ? "—" : String(v))

export function DialogOversight() {
  const dialog = useDialog()
  const sdk = useSDK()
  const i18n = useTuiI18n()
  const toast = useToast()
  const [busy, setBusy] = createSignal(false)

  const rawRequest = <T,>(options: { method: string; url: string; body?: unknown }) =>
    (sdk.client as unknown as { client: { request<D>(o: typeof options): Promise<{ data?: T; error?: unknown }> } }).client.request<T>(options)

  const [items, { refetch: refetchApprovals }] = createResource(async () => {
    const result = await rawRequest<{ items: ApprovalItem[] }>({ method: "GET", url: "/oversight/approvals" })
    if (result.error) throw result.error
    return (result.data?.items ?? []).filter((item) => item.status === "pending")
  })

  const resolve = async (item: ApprovalItem, decision: "approved" | "rejected" | "acknowledged") => {
    if (busy()) return
    setBusy(true)
    try {
      const result = await rawRequest<unknown>({
        method: "POST",
        url: "/oversight/approvals/resolve",
        body: { id: item.id, decision },
      })
      if (result.error) throw result.error
      toast.show({
        variant: "success",
        message: i18n.t(`tui.oversight.decision.${decision}`),
        duration: 4000,
      })
      await refetchApprovals()
    } catch (error) {
      toast.show({ variant: "error", message: errorMessage(error), duration: 6000 })
    } finally {
      setBusy(false)
    }
  }

  const showDetail = (item: ApprovalItem) => {
    dialog.replace(() => (
      <DialogAlert
        title={item.id}
        message={[
          `${i18n.t("tui.oversight.eventType")}: ${item.eventType}`,
          item.correlationID ? `correlation: ${item.correlationID}` : "",
          `created: ${new Date(item.createdAt).toISOString()}`,
          "",
          item.summary,
        ]
          .filter((line) => line !== "")
          .join("\n")}
      />
    ))
  }

  const showMetrics = async () => {
    const result = await rawRequest<Metrics>({ method: "GET", url: "/oversight/metrics" })
    if (result.error) {
      toast.show({ variant: "error", message: errorMessage(result.error), duration: 6000 })
      return
    }
    const m = result.data
    const lines = m
      ? [
          `${i18n.t("tui.oversight.metric.taskSuccessRate")}: ${pct(m.agentTaskSuccessRate)}`,
          `${i18n.t("tui.oversight.metric.conflictRate")}: ${pct(m.agentConflictRate)}`,
          `${i18n.t("tui.oversight.metric.dlqEvents")}: ${num(m.dlqEventsTotal)}`,
          `${i18n.t("tui.oversight.metric.pushRejected")}: ${num(m.agentPushRejectedTotal)}`,
          `${i18n.t("tui.oversight.metric.tasksCompleted")}: ${num(m.agentTaskCompleted)}`,
          `${i18n.t("tui.oversight.metric.tasksFailed")}: ${num(m.agentTaskFailed)}`,
          `${i18n.t("tui.oversight.metric.humanTakeovers")}: ${num(m.humanTakeoverTotal)}`,
          `${i18n.t("tui.oversight.metric.rollbacks")}: ${num(m.rollbackTotal)}`,
          "",
          `${i18n.t("tui.oversight.metric.window", {
            from: new Date(m.windowFrom).toISOString(),
            to: new Date(m.windowTo).toISOString(),
          })}`,
        ]
      : [i18n.t("tui.oversight.empty")]
    dialog.replace(() => <DialogAlert title={i18n.t("tui.oversight.metricsTitle")} message={lines.join("\n")} />)
  }

  const showTrace = async () => {
    const correlationID = await DialogPrompt.show(dialog, i18n.t("tui.oversight.traceTitle"), {
      placeholder: i18n.t("tui.oversight.tracePlaceholder"),
    })
    if (!correlationID?.trim()) return
    const result = await rawRequest<{ nodes: TraceNode[] }>({
      method: "GET",
      url: `/oversight/trace?correlationID=${encodeURIComponent(correlationID.trim())}`,
    })
    if (result.error) {
      toast.show({ variant: "error", message: errorMessage(result.error), duration: 6000 })
      return
    }
    const nodes = result.data?.nodes ?? []
    const lines =
      nodes.length === 0
        ? [i18n.t("tui.oversight.traceEmpty")]
        : nodes.map((node) => {
            const caused = node.causationID ? ` ← ${node.causationID}` : ""
            return `${node.createdAt ? new Date(node.createdAt).toISOString().slice(11, 19) : ""} ${node.type} [${node.source}] ${node.eventID}${caused}`
          })
    dialog.replace(() => (
      <DialogAlert title={`${i18n.t("tui.oversight.traceTitle")} — ${correlationID.trim()}`} message={lines.join("\n")} />
    ))
  }

  const takeover = async () => {
    const reason = await DialogPrompt.show(dialog, i18n.t("tui.oversight.takeoverTitle"), {
      placeholder: i18n.t("tui.oversight.takeoverPlaceholder"),
    })
    if (!reason?.trim()) return
    const result = await rawRequest<unknown>({
      method: "POST",
      url: "/oversight/takeover",
      body: { reason: reason.trim() },
    })
    if (result.error) {
      toast.show({ variant: "error", message: errorMessage(result.error), duration: 6000 })
      return
    }
    toast.show({ variant: "success", message: i18n.t("tui.oversight.takeoverRecorded"), duration: 4000 })
  }

  const rollback = async () => {
    const sessionID = await DialogPrompt.show(dialog, i18n.t("tui.oversight.rollbackTitle"), {
      placeholder: "ses_…",
    })
    if (!sessionID?.trim()) return
    const confirmed = await DialogConfirm.show(dialog, i18n.t("tui.oversight.rollbackTitle"), i18n.t("tui.oversight.rollbackConfirm"))
    if (!confirmed) return
    const result = await rawRequest<{ outcome?: string }>({
      method: "POST",
      url: "/oversight/rollback",
      body: { sessionID: sessionID.trim() },
    })
    if (result.error) {
      toast.show({ variant: "error", message: errorMessage(result.error), duration: 6000 })
      return
    }
    toast.show({
      variant: "success",
      message:
        result.data?.outcome === "noop" ? i18n.t("tui.oversight.rollbackNoop") : i18n.t("tui.oversight.rollbackApplied"),
      duration: 4000,
    })
  }

  const options = () =>
    (items.latest ?? []).map((item) => ({
      title: item.summary.length > 80 ? `${item.summary.slice(0, 80)}…` : item.summary,
      value: item.id,
      category: item.eventType,
      footer: new Date(item.createdAt).toISOString().slice(0, 16).replace("T", " "),
    }))

  const byId = () => new Map((items.latest ?? []).map((item) => [item.id, item]))

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <DialogSelect
      title={`${i18n.t("tui.oversight.title")} (${items.latest?.length ?? 0})`}
      options={options()}
      current={undefined}
      placeholder={i18n.t("tui.oversight.empty")}
      onSelect={(option) => {
        const item = byId().get(String(option.value))
        if (item) showDetail(item)
      }}
      actions={[
        {
          command: "oversight.approve",
          title: i18n.t("tui.oversight.approve"),
          onTrigger: (option: { value: string }) => {
            const item = byId().get(String(option.value))
            if (item) void resolve(item, "approved")
          },
        },
        {
          command: "oversight.reject",
          title: i18n.t("tui.oversight.reject"),
          onTrigger: (option: { value: string }) => {
            const item = byId().get(String(option.value))
            if (item) void resolve(item, "rejected")
          },
        },
        {
          command: "oversight.acknowledge",
          title: i18n.t("tui.oversight.acknowledge"),
          onTrigger: (option: { value: string }) => {
            const item = byId().get(String(option.value))
            if (item) void resolve(item, "acknowledged")
          },
        },
        {
          command: "oversight.metrics",
          title: i18n.t("tui.oversight.metricsAction"),
          onTrigger: () => void showMetrics(),
        },
        {
          command: "oversight.trace",
          title: i18n.t("tui.oversight.traceAction"),
          onTrigger: () => void showTrace(),
        },
        {
          command: "oversight.takeover",
          title: i18n.t("tui.oversight.takeoverAction"),
          onTrigger: () => void takeover(),
        },
        {
          command: "oversight.rollback",
          title: i18n.t("tui.oversight.rollbackAction"),
          onTrigger: () => void rollback(),
        },
      ]}
    />
  )
}
