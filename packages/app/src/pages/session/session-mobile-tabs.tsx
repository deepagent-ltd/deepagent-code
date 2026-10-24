import { createEffect, Show } from "solid-js"
import { Tabs } from "@deepagent-code/ui/tabs"
import { useLanguage } from "@/context/language"
import { useSessionLayout } from "./session-layout"

export function SessionMobileTabs(props: {
  tab: "session" | "changes"
  onChange: (tab: "session" | "changes") => void
  hasSession: boolean
  reviewCount: number
}) {
  const language = useLanguage()
  const { view } = useSessionLayout()
  const messages = () => view().rightPanel.mode() === "im"
  let navigation: HTMLDivElement | undefined
  let wasMessages = messages()

  createEffect(() => {
    const opened = messages()
    if (wasMessages && !opened) {
      // Restore lost focus after the panel closes, without overriding an explicit
      // return to the composer or another usable control.
      queueMicrotask(() => {
        const active = document.activeElement
        if (!navigation?.isConnected || navigation.contains(active)) return
        if (
          active instanceof HTMLElement &&
          active.isConnected &&
          active !== document.body &&
          active !== document.documentElement &&
          !active.closest('[hidden], [inert], [aria-hidden="true"]') &&
          !active.matches(':disabled, [aria-disabled="true"]')
        )
          return
        navigation.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus()
      })
    }
    wasMessages = opened
  })

  return (
    <div ref={navigation} class="shrink-0 min-w-0" data-prevent-autofocus>
      <Tabs
        value={messages() ? "im" : props.hasSession ? props.tab : "session"}
        class="h-auto"
        onChange={(tab) => {
          if (tab === "im") {
            props.onChange("session")
            view().rightPanel.open("im")
            return
          }
          if (tab !== "session" && tab !== "changes") return
          props.onChange(tab)
          view().rightPanel.close()
        }}
      >
        <Tabs.List class="after:!hidden">
          <Tabs.Trigger value="session" class="!flex-1 !min-w-0 !max-w-none" classes={{ button: "w-full truncate" }}>
            {language.t("session.tab.session")}
          </Tabs.Trigger>
          <Show when={props.hasSession}>
            <Tabs.Trigger value="changes" class="!flex-1 !min-w-0 !max-w-none" classes={{ button: "w-full truncate" }}>
              {props.reviewCount > 0
                ? language.t("session.review.filesChanged", { count: props.reviewCount })
                : language.t("session.review.change.other")}
            </Tabs.Trigger>
          </Show>
          <Tabs.Trigger
            value="im"
            class="!flex-1 !min-w-0 !max-w-none !border-r-0"
            classes={{ button: "w-full truncate" }}
          >
            {language.t("session.tab.im")}
          </Tabs.Trigger>
        </Tabs.List>
      </Tabs>
    </div>
  )
}
