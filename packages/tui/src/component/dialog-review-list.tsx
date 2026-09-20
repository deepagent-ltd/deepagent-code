import { createResource, createSignal, onMount } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useSDK } from "../context/sdk"
import { useTuiI18n } from "../context/i18n"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

type CandidateNode = {
  round: number
  ref: string
  parent: string | null
  status: string
  decisionRef: string | null
  notes: string[]
}

type LearningCandidate = {
  candidateId: string
  type: "memory" | "strategy" | "methodology"
  status: string
  sourceRunId: string
  sourceRound: number
  summary: string
  evidenceRefs: string[]
  confidence: number
}

type RunReview = {
  runId: string
  agentMode?: string | null
  status?: string | null
  nextAction?: string | null
  candidates?: CandidateNode[]
  learningCandidates?: LearningCandidate[]
  diagnosis?: {
    status?: string | null
    rootCause?: string | null
    nextAction?: string | null
  } | null
}

// W4-1 full face — the TUI review flow: run list → detail (candidate lineage + learning
// candidates with promote/reject + diagnosis). Server contract notes carried from the GUI:
// promote's verdict is advisory-only (server re-validates); approver must be non-empty; reject
// needs a non-empty reason. All routes are path-served, hence the rawRequest escape hatch.
export function DialogReviewList() {
  const dialog = useDialog()
  const sdk = useSDK()
  const i18n = useTuiI18n()
  const toast = useToast()

  const rawRequest = <T,>(options: { method: string; url: string; body?: unknown }) =>
    (sdk.client as unknown as { client: { request<D>(o: typeof options): Promise<{ data?: T; error?: unknown }> } }).client.request<T>(options)

  const [items, { refetch }] = createResource(async () => {
    const result = await rawRequest<{ reviews: RunReview[] }>({ method: "GET", url: "/deepagent/reviews" })
    if (result.error) throw result.error
    return result.data?.reviews ?? []
  })

  const openDetail = (review: RunReview) => {
    dialog.replace(() => <ReviewDetail review={review} onDone={() => void refetch()} />)
  }

  const options = () =>
    (items.latest ?? []).map((x) => ({
      title: x.runId,
      value: x.runId,
      category: "Reviews",
      footer: [
        x.status ?? i18n.t("tui.reviews.statusUnknown"),
        x.diagnosis?.rootCause ?? x.nextAction ?? "",
        x.candidates ? `${x.candidates.length} ${i18n.t("tui.reviews.candidates")}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    }))

  const byRunId = () => new Map((items.latest ?? []).map((x) => [x.runId, x]))

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <DialogSelect
      title={`${i18n.t("tui.reviews.title")}${items.latest ? ` (${items.latest.length})` : ""}`}
      options={options()}
      current={undefined}
      onSelect={(option) => {
        const review = byRunId().get(String(option.value))
        if (review) openDetail(review)
      }}
    />
  )
}

function ReviewDetail(props: { review: RunReview; onDone: () => void }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const i18n = useTuiI18n()
  const toast = useToast()
  const [busy, setBusy] = createSignal(false)

  const rawRequest = <T,>(options: { method: string; url: string; body?: unknown }) =>
    (sdk.client as unknown as { client: { request<D>(o: typeof options): Promise<{ data?: T; error?: unknown }> } }).client.request<T>(options)

  // Candidate lineage flattened as selectable rows: one node per round, parent ref shown in the
  // footer — same information density as the GUI's list rendering.
  const lineageOptions = () =>
    (props.review.candidates ?? []).map((node) => ({
      title: `r${node.round} · ${node.ref.slice(0, 24)} · ${node.status}`,
      value: node.ref,
      category: i18n.t("tui.reviews.lineage"),
      footer: [
        node.parent ? `↑ ${node.parent.slice(0, 24)}` : "",
        node.decisionRef ? `${i18n.t("tui.reviews.decision")}: ${node.decisionRef.slice(0, 24)}` : "",
        ...node.notes,
      ]
        .filter(Boolean)
        .join(" · "),
    }))

  const learningOptions = () =>
    (props.review.learningCandidates ?? []).map((candidate) => ({
      title: candidate.summary.length > 80 ? `${candidate.summary.slice(0, 80)}…` : candidate.summary,
      value: candidate.candidateId,
      category: i18n.t("tui.reviews.learning"),
      footer: [
        candidate.type,
        candidate.status,
        `conf ${candidate.confidence}`,
        `evidence ${candidate.evidenceRefs.length}`,
      ].join(" · "),
    }))

  const options = () => [...learningOptions(), ...lineageOptions()]

  const back = () => {
    dialog.replace(() => <DialogReviewList />)
  }

  const showCandidate = (candidate: LearningCandidate) => {
    const lines = [
      `${i18n.t("tui.reviews.candidateId")}: ${candidate.candidateId}`,
      `${i18n.t("tui.reviews.type")}: ${candidate.type}`,
      `${i18n.t("tui.reviews.status")}: ${candidate.status}`,
      `${i18n.t("tui.reviews.source")}: ${candidate.sourceRunId} r${candidate.sourceRound}`,
      `${i18n.t("tui.reviews.confidence")}: ${candidate.confidence}`,
      `${i18n.t("tui.reviews.evidence")}: ${candidate.evidenceRefs.join(", ") || "—"}`,
      "",
      candidate.summary,
    ]
    dialog.replace(() => (
      <DialogSelect
        title={i18n.t("tui.reviews.learning")}
        options={[
          {
            title: lines.join("\n").slice(0, 400),
            value: candidate.candidateId,
            category: candidate.type,
          },
        ]}
        current={undefined}
        actions={[
          {
            command: "review.candidate.back",
            title: i18n.t("tui.reviews.back"),
            hidden: true,
            onTrigger: () => back(),
          },
          {
            command: "review.candidate.promote",
            title: i18n.t("tui.reviews.promote"),
            onTrigger: () => void promote(candidate),
          },
          {
            command: "review.candidate.reject",
            title: i18n.t("tui.reviews.reject"),
            onTrigger: () => void reject(candidate),
          },
        ]}
        onSelect={() => {}}
      />
    ))
  }

  const promotionCandidate = (candidate: LearningCandidate) => ({
    candidate_id: candidate.candidateId,
    type: candidate.type,
    status: candidate.status,
    source_run_id: candidate.sourceRunId,
    source_round: candidate.sourceRound,
    summary: candidate.summary,
    evidence_refs: candidate.evidenceRefs,
    confidence: candidate.confidence,
  })

  const promote = async (candidate: LearningCandidate) => {
    if (busy()) return
    setBusy(true)
    try {
      const approver = await DialogPrompt.show(dialog, i18n.t("tui.reviews.approverTitle"), { placeholder: i18n.t("tui.reviews.approverPlaceholder") })
      if (!approver || !approver.trim()) {
        toast.show({ variant: "warning", message: i18n.t("tui.reviews.approverRequired"), duration: 4000 })
        return
      }
      const note = await DialogPrompt.show(dialog, i18n.t("tui.reviews.noteTitle"), { placeholder: i18n.t("tui.reviews.notePlaceholder") })
      const result = await rawRequest<{ promoted: { id: string } }>({
        method: "POST",
        url: "/deepagent/knowledge/promote",
        body: {
          candidate: promotionCandidate(candidate),
          origin: "run_local",
          verdict: { pass: true, reason: note?.trim() || "review approved", evidence: candidate.evidenceRefs },
          approval: { approver: approver.trim(), approved: true, ...(note?.trim() ? { note: note.trim() } : {}) },
        },
      })
      if (result.error) throw result.error
      toast.show({ variant: "success", message: i18n.t("tui.reviews.promoted"), duration: 4000 })
      props.onDone()
      back()
    } catch (error) {
      toast.show({ variant: "error", message: errorMessage(error), duration: 6000 })
    } finally {
      setBusy(false)
    }
  }

  const reject = async (candidate: LearningCandidate) => {
    if (busy()) return
    setBusy(true)
    try {
      const reason = await DialogPrompt.show(dialog, i18n.t("tui.reviews.rejectTitle"), { placeholder: i18n.t("tui.reviews.rejectPlaceholder") })
      if (!reason || !reason.trim()) {
        toast.show({ variant: "warning", message: i18n.t("tui.reviews.reasonRequired"), duration: 4000 })
        return
      }
      const confirm = await DialogConfirm.show(
        dialog,
        i18n.t("tui.reviews.reject"),
        i18n.t("tui.reviews.rejectConfirm", { id: candidate.candidateId }),
      )
      if (!confirm) return
      const result = await rawRequest<{ rejected: { candidateId: string } }>({
        method: "POST",
        url: "/deepagent/knowledge/reject",
        body: {
          candidate: promotionCandidate(candidate),
          reason: reason.trim(),
        },
      })
      if (result.error) throw result.error
      toast.show({ variant: "success", message: i18n.t("tui.reviews.rejected"), duration: 4000 })
      props.onDone()
      back()
    } catch (error) {
      toast.show({ variant: "error", message: errorMessage(error), duration: 6000 })
    } finally {
      setBusy(false)
    }
  }

  const header = () =>
    [
      props.review.runId,
      props.review.agentMode ?? "",
      props.review.status ?? "",
    ]
      .filter(Boolean)
      .join(" · ")

  const diagnosisFooter = () => {
    const diagnosis = props.review.diagnosis
    return [
      diagnosis?.status ?? "",
      diagnosis?.rootCause ?? "",
      diagnosis?.nextAction ? `${i18n.t("tui.reviews.next")}: ${diagnosis.nextAction}` : props.review.nextAction ?? "",
    ]
      .filter(Boolean)
      .join(" · ")
  }

  const byCandidateId = () =>
    new Map((props.review.learningCandidates ?? []).map((candidate) => [candidate.candidateId, candidate]))

  return (
    <DialogSelect
      title={header()}
      options={options()}
      current={undefined}
      onSelect={(option) => {
        const candidate = byCandidateId().get(String(option.value))
        if (candidate) showCandidate(candidate)
      }}
      actions={[
        {
          command: "review.detail.back",
          title: i18n.t("tui.reviews.back"),
          onTrigger: () => back(),
        },
      ]}
      footerHints={[{ title: diagnosisFooter().slice(0, 120), label: "" }]}
    />
  )
}
