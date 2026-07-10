import { For, Show } from "solid-js"
import { Dialog } from "@deepagent-code/ui/v2/dialog-v2"
import { useLanguage } from "@/context/language"
import type { PanelVerdict } from "./panel-goal.api"

/**
 * V3.9 §C — renders the Expert Panel verdict from a standalone consult. Shows the decision, the
 * arbiter's confidence + round count, the grounding evidence, and any preserved dissent (§C.8 不丢信息).
 */

const DECISION_LABEL_KEY: Record<PanelVerdict["decision"], string> = {
  approve: "composer.panel.verdict.approve",
  revise: "composer.panel.verdict.revise",
  block: "composer.panel.verdict.block",
  needs_human: "composer.panel.verdict.needsHuman",
}

export function PanelVerdictDialog(props: { verdict: PanelVerdict }) {
  const language = useLanguage()
  const v = () => props.verdict
  return (
    <Dialog size="large" variant="settings" title={language.t("composer.panel.verdict.title")}>
      <div class="flex flex-col gap-4 p-1" data-component="panel-verdict">
        <div class="flex items-center gap-2">
          <span class="text-15-medium text-text-base">{language.t(DECISION_LABEL_KEY[v().decision] as never)}</span>
          <span class="text-13-regular text-text-muted">
            {language.t(v().rounds === 1 ? "composer.panel.verdict.meta.one" : "composer.panel.verdict.meta.other", {
              confidence: (v().confidence * 100).toFixed(0),
              rounds: v().rounds,
            })}
          </span>
        </div>

        <Show when={v().evidence.length > 0}>
          <div class="flex flex-col gap-1">
            <span class="text-13-medium text-text-base">{language.t("composer.panel.verdict.evidence")}</span>
            <ul class="flex flex-col gap-1">
              <For each={v().evidence}>
                {(e) => <li class="text-13-regular text-text-muted">{e}</li>}
              </For>
            </ul>
          </div>
        </Show>

        <Show when={v().dissent.length > 0}>
          <div class="flex flex-col gap-2">
            <span class="text-13-medium text-text-base">{language.t("composer.panel.verdict.dissent")}</span>
            <For each={v().dissent}>
              {(d) => (
                <div class="flex flex-col gap-1 rounded-md border border-border-subtle p-2">
                  <span class="text-13-medium text-text-base capitalize">
                    {d.lens} — {d.verdict} ({(d.confidence * 100).toFixed(0)}%)
                  </span>
                  <For each={d.findings}>
                    {(f) => (
                      <div class="text-12-regular text-text-muted">
                        <span class="text-text-base">{f.summary}</span>
                        <Show when={f.file}> — {f.file}{f.line != null ? `:${f.line}` : ""}</Show>
                        <div class="italic">{f.failureScenario}</div>
                      </div>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
