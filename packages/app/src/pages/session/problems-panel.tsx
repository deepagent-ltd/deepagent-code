import { For, Show, createMemo, createResource, type Accessor } from "solid-js"
import { Icon } from "@deepagent-code/ui/icon"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"

import { parseWorkspaceDiagnostics, type Problem, type ProblemLevel } from "@/pages/session/problems-helpers"

export function ProblemsPanel(props: { active: Accessor<boolean>; onOpenFile: (path: string, line: number) => void }) {
  const sdk = useSDK()
  const file = useFile()
  const language = useLanguage()
  const [diagnostics, { refetch }] = createResource(
    props.active,
    async () => {
      const response = await sdk.client.lsp.diagnostics()
      return parseWorkspaceDiagnostics(response.data, (path) => file.normalize(path))
    },
  )

  const groups = createMemo(() => {
    const map = new Map<string, Problem[]>()
    for (const problem of diagnostics() ?? []) {
      const existing = map.get(problem.file) ?? []
      existing.push(problem)
      map.set(problem.file, existing)
    }
    return Array.from(map.entries()).map(([path, problems]) => ({ path, relativeFile: problems[0]!.relativeFile, problems }))
  })
  const counts = createMemo(() => {
    const initial: Record<ProblemLevel, number> = { error: 0, warning: 0, information: 0, hint: 0 }
    for (const problem of diagnostics() ?? []) initial[problem.level]++
    return initial
  })

  return (
    <section class="size-full min-w-0 overflow-auto bg-background-base" aria-label={language.t("session.panel.problems")}>
      <header class="h-10 px-3 flex items-center gap-2 border-b border-border-weaker-base">
        <div class="min-w-0 flex-1 text-14-medium text-text-strong">{language.t("session.panel.problems")}</div>
        <div class="flex items-center gap-2 text-12-regular text-text-weak" aria-live="polite">
          <Show when={counts().error}><span>{counts().error} {language.t("problems.error")}</span></Show>
          <Show when={counts().warning}><span>{counts().warning} {language.t("problems.warning")}</span></Show>
        </div>
        <IconButton icon="history" aria-label={language.t("common.refresh")} title={language.t("common.refresh")} onClick={() => void refetch()} />
      </header>
      <Show when={diagnostics.loading}>
        <div class="p-3 text-13-regular text-text-weak">{language.t("common.loading")}{language.t("common.loading.ellipsis")}</div>
      </Show>
      <Show when={diagnostics.error}>
        <div class="p-3 flex flex-col items-start gap-3 text-13-regular text-text-weak">
          <div>{language.t("problems.errorLoading")}</div>
          <button class="text-13-medium text-text-info hover:underline" onClick={() => void refetch()}>{language.t("common.retry")}</button>
        </div>
      </Show>
      <Show when={!diagnostics.loading && !diagnostics.error && groups().length === 0}>
        <div class="p-3 text-13-regular text-text-weak">{language.t("problems.empty")}</div>
      </Show>
      <For each={groups()}>
        {(group) => (
          <div class="border-b border-border-weaker-base">
            <div class="px-3 py-2 text-12-medium text-text-weak truncate" title={group.relativeFile}>{group.relativeFile}</div>
            <For each={group.problems}>
              {(problem) => (
                <button
                  class="w-full px-3 py-2 flex items-start gap-2 text-left hover:bg-surface-base-active focus-visible:outline-none focus-visible:bg-surface-base-active"
                  onClick={() => props.onOpenFile(problem.file, problem.range.start.line)}
                >
                  <Icon name={problem.level === "error" ? "circle-x" : problem.level === "warning" ? "warning" : "circle-check"} size="small" class={problem.level === "error" ? "text-icon-critical" : problem.level === "warning" ? "text-icon-warning" : "text-icon-info"} />
                  <div class="min-w-0 flex-1">
                    <div class="text-13-regular text-text-strong break-words">{problem.message}</div>
                    <div class="mt-1 text-12-regular text-text-weak">
                      {problem.range.start.line + 1}:{problem.range.start.character + 1}
                      <Show when={problem.source}> · {problem.source}</Show>
                      <Show when={problem.code !== undefined}> · {String(problem.code)}</Show>
                    </div>
                  </div>
                </button>
              )}
            </For>
          </div>
        )}
      </For>
    </section>
  )
}
