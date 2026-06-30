import { Component, createMemo, For, Show } from "solid-js"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { useNavigate } from "@solidjs/router"

// U4 (S1 §P1): subagent list panel. Subagents = child sessions (Session.parentID === current). The
// task tool already spawns them and the app already receives session.created/updated events with
// parentID; this surfaces them as a list with status + click-to-open. Plan-step linkage is shown
// via the child session title (the task tool titles children "<desc> (@<agent> subagent)").
export const SidePanelSubagents: Component<{ sessionID?: string; onClose: () => void }> = (props) => {
  const sync = useSync()
  const language = useLanguage()
  const navigate = useNavigate()

  const children = createMemo(() => {
    const id = props.sessionID
    if (!id) return []
    return sync.data.session
      .filter((s) => s.parentID === id)
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
  })

  const statusOf = (id: string): "running" | "idle" => (sync.data.session_working(id) ? "running" : "idle")

  return (
    <div class="h-full w-full min-w-0 overflow-y-auto bg-background-base">
      <div class="sticky top-0 z-10 h-10 flex items-center justify-between px-3 bg-background-base">
        <span class="text-12-medium text-text">{language.t("session.subagents.title")}</span>
        <IconButton
          icon="close-small"
          variant="ghost"
          class="h-7 w-7 rounded-md"
          onClick={props.onClose}
          aria-label={language.t("common.close")}
        />
      </div>
      <Show
        when={children().length > 0}
        fallback={
          <div class="flex-1 pb-64 flex items-center justify-center text-center">
            <div class="text-12-regular text-text-weak">{language.t("session.subagents.empty")}</div>
          </div>
        }
      >
        <div class="flex flex-col gap-1 px-2 py-2">
          <For each={children()}>
            {(child) => (
              <button
                type="button"
                class="w-full flex items-center justify-between gap-2 rounded-md px-2 py-2 text-left hover:bg-background-stronger"
                onClick={() => navigate(`/session/${child.id}`)}
              >
                <div class="flex flex-col gap-0.5 min-w-0">
                  <span class="truncate text-12-regular text-text">{child.title || child.id}</span>
                  <span class="text-11-regular text-text-weaker">
                    {language.t(
                      statusOf(child.id) === "running" ? "session.subagents.running" : "session.subagents.idle",
                    )}
                  </span>
                </div>
                <Show when={statusOf(child.id) === "running"}>
                  <span
                    class="h-2 w-2 shrink-0 rounded-full bg-text-success"
                    style={{ animation: "var(--animate-pulse-scale)" }}
                  />
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
