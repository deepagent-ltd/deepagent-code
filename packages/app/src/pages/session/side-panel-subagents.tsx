import { Component, createMemo, For, Show } from "solid-js"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { useNavigate, useParams } from "@solidjs/router"

// U4 (S1 §P1): subagent list panel. Subagents = child sessions (Session.parentID === current). The
// task tool already spawns them and the app already receives session.created/updated events with
// parentID; this surfaces them as a list with status + click-to-open. Plan-step linkage is shown
// via the child session title (the task tool titles children "<desc> (@<agent> subagent)").
//
// The current session id is the ROUTE param (`params.id`) — a plain SessionID that matches a
// child's `Session.parentID`. It must NOT come from the caller's composite `sessionKey()`
// (scope+route SessionStateKey): that never equals a child's parentID, so the list was always
// empty. Resolving it internally here (like SidePanelIM / SidePanelDebug do) keeps the contract
// simple and immune to that mismatch.
export const SidePanelSubagents: Component<{ onClose: () => void }> = (props) => {
  const sync = useSync()
  const language = useLanguage()
  const navigate = useNavigate()
  const params = useParams()

  const children = createMemo(() => {
    const id = params.id
    if (!id) return []
    return sync.data.session
      .filter((s) => s.parentID === id)
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
  })

  // Three states. A subagent does one turn then finishes: the task tool persists a terminal marker
  // in the child session's metadata (`deepagent.subagent.finished`) so a completed subagent reads as
  // "finished" (read-only) instead of "idle" (looks available). `session_working` is the live signal
  // for the brief window it's actually running; the persisted marker wins once set.
  const isFinished = (child: { metadata?: Record<string, unknown> }): boolean => {
    const sub = (child.metadata?.["deepagent"] as { subagent?: { finished?: boolean } } | undefined)?.subagent
    return sub?.finished === true
  }
  const statusOf = (child: { id: string; metadata?: Record<string, unknown> }): "running" | "finished" | "idle" => {
    if (sync.data.session_working(child.id)) return "running"
    if (isFinished(child)) return "finished"
    return "idle"
  }
  const statusLabel = (state: "running" | "finished" | "idle") =>
    language.t(
      state === "running"
        ? "session.subagents.running"
        : state === "finished"
          ? "session.subagents.finished"
          : "session.subagents.idle",
    )

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
                // The router nests every session route under a required `:dir` segment
                // (`/:dir/session/:id`). Navigating to a bare `/session/${id}` matches no child
                // route and renders a blank (black) panel. `params.dir` is the parent's dir and
                // the subagent lives in the same scope, so it's the correct prefix — matching every
                // other session navigation in the app (message-timeline, session-composer, etc.).
                onClick={() => navigate(`/${params.dir}/session/${child.id}`)}
              >
                <div class="flex flex-col gap-0.5 min-w-0">
                  <span class="truncate text-12-regular text-text">{child.title || child.id}</span>
                  <span class="text-11-regular text-text-weaker">{statusLabel(statusOf(child))}</span>
                </div>
                <Show when={statusOf(child) === "running"}>
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
