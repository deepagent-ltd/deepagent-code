import { createMemo, type JSX } from "solid-js"
import { Select } from "@deepagent-code/ui/select"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"

/**
 * Approval-mode control for the composer toolbar, next to the agent (build/plan) selector.
 *
 * Mirrors Codex's approval selector UX, simplified to two options: the button shows the CURRENT mode
 * ("Request approval" by default, "Auto-approve" when armed); clicking opens a small picker to switch.
 * The mode is DIRECTORY-scoped (persists across sessions in the same workspace), backed by the existing
 * permission context (isAutoAcceptingDirectory / toggleAutoAcceptDirectory) — the same state the old
 * settings toggle drove, now surfaced where the user acts.
 */

type ApprovalMode = "request" | "auto"

export function ApprovalControl(props: { directory: string; triggerStyle?: JSX.CSSProperties; onAfter?: () => void }) {
  const language = useLanguage()
  const permission = usePermission()

  const auto = createMemo(() => (props.directory ? permission.isAutoAcceptingDirectory(props.directory) : false))
  const current = createMemo<ApprovalMode>(() => (auto() ? "auto" : "request"))

  const options: ApprovalMode[] = ["request", "auto"]
  const label = (mode: ApprovalMode) =>
    mode === "auto"
      ? language.t("composer.approval.auto")
      : language.t("composer.approval.request")

  const onSelect = (mode: ApprovalMode | undefined) => {
    if (!mode || !props.directory) return
    const isAuto = mode === "auto"
    if (isAuto === auto()) return
    // toggleAutoAcceptDirectory flips the directory-level state; only call it when the target differs.
    permission.toggleAutoAcceptDirectory(props.directory)
    props.onAfter?.()
  }

  return (
    <Select
      size="normal"
      data-component="prompt-approval-control"
      options={options}
      current={current()}
      value={(o) => o}
      label={label}
      onSelect={onSelect}
      class="capitalize max-w-[160px] text-text-base"
      valueClass="truncate text-13-regular text-text-base"
      triggerStyle={props.triggerStyle}
      triggerProps={{ "data-action": "prompt-approval" }}
      variant="ghost"
    />
  )
}
