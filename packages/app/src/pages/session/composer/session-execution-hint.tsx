import { Match, Switch } from "solid-js"
import type { SessionStatus } from "@deepagent-code/sdk/client"
import { Icon } from "@deepagent-code/ui/icon"
import { useLanguage } from "@/context/language"

export function SessionExecutionHint(props: { status?: SessionStatus }) {
  const language = useLanguage()
  return (
    <Switch>
      <Match when={props.status?.type === "recovery_required"}>
        <div
          data-component="recovery-hint"
          role="status"
          class="px-2.5 py-2 text-12-regular text-text-base bg-background-weak break-words"
        >
          {language.t("composer.recovery.hint")}
        </div>
      </Match>
      <Match when={props.status?.type === "busy" || props.status?.type === "retry"}>
        {/* The opaque row prevents the composer overlap from covering todo content. */}
        <div
          data-component="steer-hint"
          class="flex items-center gap-1.5 px-2.5 py-1 text-11-regular text-text-weak bg-background-weak"
        >
          <Icon name="intelligence" class="size-3.5 shrink-0" />
          <span class="truncate">{language.t("composer.steer.hint")}</span>
        </div>
      </Match>
    </Switch>
  )
}
