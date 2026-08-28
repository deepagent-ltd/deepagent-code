import { createMemo, type JSX } from "solid-js"
import { Select } from "@deepagent-code/ui/select"
import { useLanguage } from "@/context/language"
import { usePermission, type DirectoryApprovalMode } from "@/context/permission"

/**
 * Approval-mode control for the composer toolbar, next to the agent (build/plan) selector.
 *
 * Mirrors Codex's approval selector UX: it collapses the approval×sandbox space into three named
 * presets. The button shows the CURRENT mode; clicking opens a small picker to switch:
 *   - "Read-Only"     — the agent may read/search but write/edit/bash requests are auto-rejected.
 *   - "Request" (default) — normal permission flow; the agent asks before write/execute.
 *   - "Full-Access"   — auto-approve everything (the old directory-level auto-accept).
 *
 * The mode is DIRECTORY-scoped (persists across sessions in the same workspace), backed by the
 * permission context tri-state (directoryApprovalMode / setDirectoryApprovalMode). Full-Access maps
 * onto the existing isAutoAcceptingDirectory / toggleAutoAcceptDirectory state the old settings
 * toggle drove, now surfaced where the user acts.
 */

type ApprovalMode = DirectoryApprovalMode

export function ApprovalControl(props: { directory: string; triggerStyle?: JSX.CSSProperties; onAfter?: () => void }) {
  const language = useLanguage()
  const permission = usePermission()

  const current = createMemo<ApprovalMode>(() =>
    props.directory ? permission.directoryApprovalMode(props.directory) : "request",
  )

  const options: ApprovalMode[] = ["read-only", "request", "full-access"]
  const label = (mode: ApprovalMode) => {
    switch (mode) {
      case "read-only":
        return language.t("composer.approval.readOnly")
      case "full-access":
        return language.t("composer.approval.fullAccess")
      default:
        return language.t("composer.approval.request")
    }
  }

  const onSelect = (mode: ApprovalMode | undefined) => {
    if (!mode || !props.directory) return
    if (mode === current()) return
    permission.setDirectoryApprovalMode(props.directory, mode)
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
      class="max-w-[180px] text-text-base"
      valueClass="truncate text-13-regular text-text-base"
      triggerStyle={props.triggerStyle}
      triggerProps={{ "data-action": "prompt-approval" }}
      variant="ghost"
    />
  )
}
