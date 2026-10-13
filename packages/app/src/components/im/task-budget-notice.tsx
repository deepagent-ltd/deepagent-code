import { Show } from "solid-js"
import { useLanguage } from "@/context/language"

export function TaskBudgetNotice(props: { target: { profile: { id: string }; budget: {
  maxInputTokens: number; maxCompletionTokens: number; maxTotalTokens: number; hourTokensMax: number
} } }) {
  const language = useLanguage()
  return <Show when={props.target.profile.id === "project_deepseek_context_bound_v1"}>
    <p data-im-task-budget-notice class="text-12-regular text-text-weak [overflow-wrap:anywhere]">
      {language.t("im.taskProposal.contextReservation", {
        input: props.target.budget.maxInputTokens,
        output: props.target.budget.maxCompletionTokens,
        reservation: props.target.budget.maxInputTokens + props.target.budget.maxCompletionTokens,
        total: props.target.budget.maxTotalTokens,
        hour: props.target.budget.hourTokensMax,
      })}
    </p>
  </Show>
}
