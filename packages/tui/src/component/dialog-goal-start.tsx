import { GoalClient } from "@deepagent-code/core/deepagent/goal-client"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import type { DialogContext } from "../ui/dialog"

export async function openGoalStart(input: {
  dialog: DialogContext
  current: () => boolean
  text: (key: string) => string
}) {
  const form = {
    source: "session",
    preset: "default",
    commands: "",
    codeRefs: "",
    diagnostics: "none",
    reviewer: "none",
  }
  const choose = (title: string, options: { title: string; value: string; description?: string }[]) =>
    new Promise<string | undefined>((resolve) =>
      input.dialog.replace(
        () => (
          <DialogSelect
            title={title}
            options={options}
            skipFilter
            renderFilter={false}
            onSelect={(option) => resolve(option.value)}
          />
        ),
        () => resolve(undefined),
      ),
    )
  const edit = (title: string, value: string) =>
    new Promise<string | undefined>((resolve) =>
      input.dialog.replace(
        () => <DialogPrompt title={title} value={value} onConfirm={resolve} onCancel={() => resolve(undefined)} />,
        () => resolve(undefined),
      ),
    )
  while (input.current()) {
    const action = await choose(input.text("title"), [
      { title: input.text("source"), value: "source", description: input.text(form.source) },
      { title: input.text("criteria"), value: "preset", description: input.text(form.preset) },
      ...(form.preset === "custom"
        ? [
            { title: input.text("commands"), value: "commands", description: form.commands },
            { title: input.text("diagnostics"), value: "diagnostics", description: form.diagnostics },
            { title: input.text("reviewer"), value: "reviewer", description: form.reviewer },
          ]
        : []),
      { title: input.text("codeRefs"), value: "codeRefs", description: form.codeRefs },
      { title: input.text("start"), value: "start", description: input.text("hint") },
      { title: input.text("cancel"), value: "cancel" },
    ])
    if (!input.current() || !action || action === "cancel") return
    if (action === "source") {
      form.source = form.source === "session" ? "workspace-file" : "session"
      continue
    }
    if (action === "preset") {
      form.preset = form.preset === "default" ? "custom" : "default"
      continue
    }
    if (action === "commands" || action === "codeRefs") {
      const value = await edit(input.text(action), form[action])
      if (!input.current() || value === undefined) return
      form[action] = value
      continue
    }
    if (action === "diagnostics" || action === "reviewer") {
      const values =
        action === "diagnostics" ? ["none", "error", "warning", "info", "hint"] : ["none", "high", "medium", "low"]
      const value = await choose(
        input.text(action),
        values.map((value) => ({ value, title: value === "none" ? input.text("omit") : value })),
      )
      if (!input.current() || value === undefined) return
      form[action] = value
      continue
    }
    const criteria: NonNullable<GoalClient.StartInput["criteria"]>[number][] = [{ kind: "plan_complete" }]
    const commands = form.commands
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
    if (commands.length) criteria.push({ kind: "tests_pass", commands })
    if (form.diagnostics !== "none") criteria.push({ kind: "no_diagnostics", severityAtMost: form.diagnostics })
    if (form.reviewer !== "none") criteria.push({ kind: "reviewer_clean", maxSeverity: form.reviewer })
    const result = {
      ...(form.preset === "custom" ? { criteria } : {}),
      ...(form.source === "workspace-file" ? { planSource: "workspace-file" as const } : {}),
      codeRefs: form.codeRefs
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    }
    GoalClient.validateStartInput({ sessionID: "draft", requestID: "draft", ...result })
    return result
  }
}
