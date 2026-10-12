import { Show } from "solid-js"
import { Button } from "@deepagent-code/ui/button"
import { Spinner } from "@deepagent-code/ui/spinner"
import { useLanguage } from "@/context/language"

export function SessionHistoryLoadState(props: { error: unknown; loading: boolean; retry: () => void }) {
  const language = useLanguage()
  return (
    <div data-session-history-load-state class="flex h-full min-h-32 flex-col items-center justify-center gap-3 px-4 text-center">
      <Show when={props.error} fallback={
        <div role="status" class="flex items-center gap-2 text-13-regular text-text-weak">
          <Spinner class="size-4" />{language.t("common.loading")}
        </div>
      }>
        <p role="alert" class="text-13-regular text-text-critical">{language.t("common.requestFailed")}</p>
        <Button variant="secondary" disabled={props.loading} onClick={props.retry}>
          {language.t("recovery.list.retry")}
        </Button>
      </Show>
    </div>
  )
}
