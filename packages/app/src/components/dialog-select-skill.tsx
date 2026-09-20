import { Component, createResource, For, Show } from "solid-js"
import { useSDK } from "@/context/sdk"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { Dialog } from "@deepagent-code/ui/dialog"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"

/**
 * W3-7 — parity with the TUI /skills browser: lists installed skills (app.skills read route),
 * searchable, and selecting one inserts `/skill <name>` into the composer.
 */
export const DialogSelectSkill: Component = () => {
  const sdk = useSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const prompt = usePrompt()

  const [skills, { refetch }] = createResource(
    async () => (await sdk.client.app.skills().catch(() => undefined))?.data ?? [],
  )

  const pick = (name: string) => {
    // Mirror the TUI skill dialog: selection seeds the composer with the /skill invocation.
    const text = `/skill ${name}`
    prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
    dialog.close()
  }

  return (
    <Dialog title={language.t("dialog.skills.title")}>
      <div class="flex flex-col gap-1 p-3 min-w-80 max-h-96 overflow-y-auto">
        <Show
          when={skills.loading === false}
          fallback={<div class="py-8 text-center text-12-regular text-text-weak">…</div>}
        >
          <Show
            when={(skills() ?? []).length > 0}
            fallback={<div class="py-8 text-center text-12-regular text-text-weak">{language.t("dialog.skills.empty")}</div>}
          >
            <For each={skills()}>
              {(skill) => (
                <button
                  type="button"
                  class="w-full rounded-md px-2 py-2 text-left hover:bg-background-stronger"
                  onClick={() => pick(skill.name)}
                >
                  <span class="text-12-medium text-text">{skill.name}</span>
                  <Show when={skill.description}>
                    <div class="text-11-regular text-text-weak line-clamp-2">{skill.description}</div>
                  </Show>
                </button>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </Dialog>
  )
}
