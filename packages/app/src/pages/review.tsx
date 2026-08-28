import { useData } from "@deepagent-code/ui/context"
import { Button } from "@deepagent-code/ui/button"
import { createMutation } from "@tanstack/solid-query"
import { For, Show, createResource, createSignal } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"

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
export type { LearningCandidate }
type RunReview = {
  runId: string
  agentMode: string | null
  status: string | null
  nextAction: string | null
  candidates: CandidateNode[]
  diagnosis: { status: string | null; rootCause: string | null; nextAction: string | null } | null
  runContext: string | null
  learningCandidates: LearningCandidate[]
}
type PromotionPayload = {
  directory: string
  candidate: ReturnType<typeof promotionCandidate>
  origin: "run_local"
  verdict: { pass: true; reason: string; evidence: string[] }
  approval: { approver: string; approved: true; note?: string }
}
type RejectionPayload = {
  directory: string
  candidate: ReturnType<typeof promotionCandidate>
  reason: string
}

const statusTone = (status: string | null): string => {
  if (status === "completed") return "bg-icon-success-base"
  if (status === "failed" || status === "blocked") return "bg-icon-critical-base"
  return "bg-icon-warning-base"
}

export const promotionCandidate = (candidate: LearningCandidate) => ({
  candidate_id: candidate.candidateId,
  type: candidate.type,
  status: "staged" as const,
  source_run_id: candidate.sourceRunId,
  source_round: candidate.sourceRound,
  summary: candidate.summary,
  evidence_refs: candidate.evidenceRefs,
  confidence: candidate.confidence,
})

export async function promoteLearningCandidate(input: {
  client: { deepagent: { knowledge: { promote: (payload: PromotionPayload) => unknown } } }
  directory: string
  candidate: LearningCandidate
  approver: string
  note: string
}) {
  const reviewer = input.approver.trim()
  if (!reviewer) throw new Error("请先填写审批人")
  const note = input.note.trim()
  return await input.client.deepagent.knowledge.promote({
    directory: input.directory,
    candidate: promotionCandidate(input.candidate),
    origin: "run_local",
    verdict: { pass: true, reason: note || "review approved", evidence: input.candidate.evidenceRefs },
    approval: { approver: reviewer, approved: true, note: note || undefined },
  })
}

export async function rejectLearningCandidate(input: {
  client: { deepagent: { knowledge: { reject: (payload: RejectionPayload) => unknown } } }
  directory: string
  candidate: LearningCandidate
  reason: string
}) {
  const reason = input.reason.trim()
  if (!reason) throw new Error("请先填写拒绝理由")
  return await input.client.deepagent.knowledge.reject({
    directory: input.directory,
    candidate: promotionCandidate(input.candidate),
    reason,
  })
}

export default function ReviewRoute() {
  const data = useData()
  const serverSDK = useServerSDK()
  const [selected, setSelected] = createSignal<string | null>(null)
  const [approver, setApprover] = createSignal("")
  const [reviewNote, setReviewNote] = createSignal("")
  const [rejectReason, setRejectReason] = createSignal("")
  const [reviews, { refetch }] = createResource(
    () => data.directory,
    async (directory) => ((await serverSDK.client.deepagent.reviews({ directory })).data?.reviews ?? []) as RunReview[],
  )
  const review = () => (reviews() ?? []).find((r) => r.runId === selected()) ?? null
  const learning = () => review()?.learningCandidates ?? []

  const promoteMutation = createMutation(() => ({
    mutationFn: async (candidate: LearningCandidate) => {
      return await promoteLearningCandidate({
        client: serverSDK.client,
        directory: data.directory,
        candidate,
        approver: approver(),
        note: reviewNote(),
      })
    },
    onSuccess: async () => {
      showToast({ variant: "success", title: "已晋升", description: "候选知识已写入 durable store" })
      await refetch()
    },
    onError: (error) => {
      showToast({
        variant: "error",
        title: "晋升失败",
        description: error instanceof Error ? error.message : String(error),
      })
    },
  }))

  const rejectMutation = createMutation(() => ({
    mutationFn: async (input: { candidate: LearningCandidate; reason: string }) => {
      return await rejectLearningCandidate({
        client: serverSDK.client,
        directory: data.directory,
        candidate: input.candidate,
        reason: input.reason,
      })
    },
    onSuccess: async () => {
      showToast({ variant: "success", title: "已拒绝", description: "候选已写入 rejection buffer" })
      await refetch()
    },
    onError: (error) => {
      showToast({
        variant: "error",
        title: "拒绝失败",
        description: error instanceof Error ? error.message : String(error),
      })
    },
  }))

  return (
    <div class="flex h-full min-h-0">
      <aside class="w-64 shrink-0 overflow-y-auto border-r border-border-weak p-3">
        <div class="mb-2 text-12-medium text-text-weak">DeepAgent Runs</div>
        <Show
          when={(reviews() ?? []).length > 0}
          fallback={<div class="text-12-regular text-text-weak">没有可复盘的 run</div>}
        >
          <For each={reviews()}>
            {(r) => (
              <button
                class="block w-full truncate rounded px-2 py-1 text-left text-12-regular hover:bg-surface-weak"
                classList={{ "bg-surface-weak": selected() === r.runId }}
                onClick={() => setSelected(r.runId)}
              >
                {r.runId}
              </button>
            )}
          </For>
        </Show>
      </aside>

      <section class="min-w-0 flex-1 overflow-y-auto p-4">
        <Show when={review()} fallback={<div class="text-13-regular text-text-weak">选择一个 run 查看复盘</div>}>
          {(r) => (
            <div class="flex flex-col gap-4">
              <header class="flex items-center gap-3">
                <span class={`size-2 rounded-full ${statusTone(r().status)}`} />
                <h1 class="text-16-medium text-text-strong">{r().runId}</h1>
                <span class="text-12-regular text-text-weak">
                  mode={r().agentMode ?? "-"} · status={r().status ?? "-"}
                </span>
              </header>

              <Show when={r().nextAction}>
                <div class="text-13-regular text-text-base">下一步: {r().nextAction}</div>
              </Show>

              <div>
                <div class="mb-1 text-12-medium text-text-weak">候选谱系 (为何 accept / rollback)</div>
                <For each={r().candidates} fallback={<div class="text-12-regular text-text-weak">无候选记录</div>}>
                  {(c) => (
                    <div class="rounded border border-border-weak p-2 text-12-regular">
                      <div class="font-mono text-text-strong">
                        round {c.round} · {c.ref} · {c.status}
                      </div>
                      <Show when={c.parent}>
                        <div class="text-text-weak">parent: {c.parent}</div>
                      </Show>
                      <For each={c.notes}>{(n) => <div class="text-text-weak">- {n}</div>}</For>
                    </div>
                  )}
                </For>
              </div>

              <div>
                <div class="mb-1 text-12-medium text-text-weak">学习候选</div>
                <div class="mb-2 grid gap-2 md:grid-cols-3">
                  <label class="flex min-w-0 flex-col gap-1 text-12-regular text-text-base">
                    <span class="text-text-weak">审批人</span>
                    <input
                      class="rounded border border-border-weak bg-background-panel px-2 py-1 outline-none focus:border-border-strong"
                      value={approver()}
                      onInput={(event) => setApprover(event.currentTarget.value)}
                    />
                  </label>
                  <label class="flex min-w-0 flex-col gap-1 text-12-regular text-text-base">
                    <span class="text-text-weak">批准备注</span>
                    <input
                      class="rounded border border-border-weak bg-background-panel px-2 py-1 outline-none focus:border-border-strong"
                      value={reviewNote()}
                      onInput={(event) => setReviewNote(event.currentTarget.value)}
                    />
                  </label>
                  <label class="flex min-w-0 flex-col gap-1 text-12-regular text-text-base">
                    <span class="text-text-weak">拒绝理由</span>
                    <input
                      class="rounded border border-border-weak bg-background-panel px-2 py-1 outline-none focus:border-border-strong"
                      value={rejectReason()}
                      onInput={(event) => setRejectReason(event.currentTarget.value)}
                    />
                  </label>
                </div>
                <For each={learning()} fallback={<div class="text-12-regular text-text-weak">无学习候选</div>}>
                  {(candidate) => (
                    <div class="flex items-start justify-between gap-3 rounded border border-border-weak p-2 text-12-regular">
                      <div class="min-w-0">
                        <div class="font-mono text-text-strong">
                          {candidate.type} · {candidate.candidateId}
                        </div>
                        <div class="text-text-weak">{candidate.summary}</div>
                        <div class="text-text-weak">
                          evidence={candidate.evidenceRefs.join(", ")} · confidence={candidate.confidence.toFixed(2)}
                        </div>
                      </div>
                      <div class="flex shrink-0 gap-2">
                        <Button
                          variant="secondary"
                          size="small"
                          disabled={promoteMutation.isPending || candidate.status !== "staged"}
                          onClick={() =>
                            promoteMutation.mutate(candidate, {
                              onSuccess: async () => {
                                showToast({ variant: "success", title: "已晋升", description: candidate.candidateId })
                                await refetch()
                              },
                            })
                          }
                        >
                          晋升
                        </Button>
                        <Button
                          variant="ghost"
                          size="small"
                          disabled={rejectMutation.isPending || candidate.status !== "staged"}
                          onClick={() =>
                            rejectMutation.mutate(
                              { candidate, reason: rejectReason() },
                              {
                                onSuccess: async () => {
                                  showToast({ variant: "success", title: "已拒绝", description: candidate.candidateId })
                                  await refetch()
                                },
                              },
                            )
                          }
                        >
                          拒绝
                        </Button>
                      </div>
                    </div>
                  )}
                </For>
              </div>

              <Show when={r().diagnosis}>
                {(d) => (
                  <div>
                    <div class="mb-1 text-12-medium text-text-weak">诊断</div>
                    <div class="text-12-regular text-text-base">
                      status={d().status ?? "-"} · root cause={d().rootCause ?? "-"} · next={d().nextAction ?? "-"}
                    </div>
                  </div>
                )}
              </Show>

              <Show when={r().runContext}>
                {(ctx) => (
                  <details>
                    <summary class="cursor-pointer text-12-medium text-text-weak">RUN_CONTEXT</summary>
                    <pre class="mt-1 whitespace-pre-wrap rounded bg-surface-weak p-2 text-11-regular">{ctx()}</pre>
                  </details>
                )}
              </Show>
            </div>
          )}
        </Show>
      </section>
    </div>
  )
}
