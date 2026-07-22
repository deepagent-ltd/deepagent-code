import { Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { useNavigate, useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { fetchCapabilities } from "@/components/deepagent/panel-goal.api"
import { OversightDashboard } from "@/components/deepagent/oversight-dashboard"
import { isInterruptedSubagent } from "./subagent-state"

// Phase 2 (§3): SidePanelSubagents is now the single "子Agent监督" entry for the right rail.
// It holds a `selectedSessionID` to track which subagent is being inspected; that selection
// drives the embedded OversightDashboard (takeover, rollback, trace) when the
// v4MultiAgentRuntime capability is on. The oversight content is capability-gated: when the
// capability is off only the basic subagent list is shown.
//
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
  const sdk = useSDK()

  // ── capability gate ─────────────────────────────────────────────────────────
  // v4MultiAgentRuntime ON ⇒ show the oversight section; OFF ⇒ basic subagent list only.
  // Tolerant of an older server (fetch fails ⇒ capability treated OFF).
  const [capabilities] = createResource(() =>
    fetchCapabilities(sdk.client as unknown as Parameters<typeof fetchCapabilities>[0]).catch(() => null),
  )
  const oversightEnabled = () => capabilities()?.v4MultiAgentRuntime ?? false

  // ── subagent list ───────────────────────────────────────────────────────────
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
  // Phase 2 adds "interrupted" for subagents that were manually stopped.
  const isFinished = (child: { metadata?: Record<string, unknown> }): boolean => {
    const sub = (child.metadata?.["deepagent"] as { subagent?: { finished?: boolean } } | undefined)?.subagent
    return sub?.finished === true
  }
  const isInterrupted = isSubagentInterrupted
  const statusOf = (
    child: { id: string; metadata?: Record<string, unknown> },
  ): "running" | "finished" | "interrupted" | "idle" => {
    if (sync.data.session_working(child.id)) return "running"
    if (isInterrupted(child)) return "interrupted"
    if (isFinished(child)) return "finished"
    return "idle"
  }
  const statusLabel = (state: "running" | "finished" | "interrupted" | "idle") =>
    language.t(
      state === "running"
        ? "session.subagents.running"
        : state === "finished"
          ? "session.subagents.finished"
          : state === "interrupted"
            ? "session.subagents.interrupted"
            : "session.subagents.idle",
    )

  // ── selected session (監督対象) ───────────────────────────────────────────────
  // §3.4.1: auto-select priority — running → interrupted → most-recent.
  // Clicking a row sets an explicit override; clicking again deselects back to auto.
  const defaultSelected = createMemo<string | undefined>(() => {
    const list = children()
    if (list.length === 0) return undefined
    const running = list.find((s) => sync.data.session_working(s.id))
    if (running) return running.id
    const interrupted = list.find((s) => isInterrupted(s))
    if (interrupted) return interrupted.id
    return list[0].id
  })

  // null means "follow auto"; a string means the user explicitly picked this row.
  const [explicitSelected, setExplicitSelected] = createSignal<string | undefined>(undefined)
  const selectedSessionID = createMemo(() => explicitSelected() ?? defaultSelected())

  const selectRow = (id: string) => {
    // §3.4.2: clicking a row selects it without navigating away. [Open] button navigates.
    setExplicitSelected((prev) => (prev === id ? undefined : id))
  }

  return (
    <div class="h-full w-full min-w-0 overflow-y-auto bg-background-base">
      <div class="sticky top-0 z-10 h-10 flex items-center justify-between px-3 bg-background-base border-b border-border-weaker-base">
        <span class="text-12-medium text-text">{language.t("session.subagents.title")}</span>
        <IconButton
          icon="close-small"
          variant="ghost"
          class="h-7 w-7 rounded-md"
          onClick={props.onClose}
          aria-label={language.t("common.close")}
        />
      </div>

      {/* ── Subagent list ── */}
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
            {(child) => {
              const status = () => statusOf(child)
              const isSelected = () => selectedSessionID() === child.id
              return (
                <div
                  class="w-full rounded-md px-2 py-2 text-left"
                  classList={{
                    "bg-surface-raised-base-active ring-1 ring-border-strong-base": isSelected(),
                    "hover:bg-background-stronger": !isSelected(),
                  }}
                >
                  {/* §3.4.2: click the row body to select; [Open] navigates. */}
                  <button
                    type="button"
                    class="w-full flex items-center justify-between gap-2 text-left"
                    onClick={() => selectRow(child.id)}
                  >
                    <div class="flex flex-col gap-0.5 min-w-0">
                      <span class="truncate text-12-regular text-text">{child.title || child.id}</span>
                      <span class="text-11-regular text-text-weaker">{statusLabel(status())}</span>
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0">
                      <Show when={status() === "running"}>
                        <span
                          class="h-2 w-2 rounded-full bg-text-success"
                          style={{ animation: "var(--animate-pulse-scale)" }}
                        />
                      </Show>
                      <Show when={status() === "interrupted"}>
                        <span class="h-2 w-2 rounded-full bg-text-warning" />
                      </Show>
                      {/* §3.4.3: [Open] button navigates to the subagent's full session. */}
                      <button
                        type="button"
                        class="text-11-regular text-text-link hover:underline px-1"
                        onClick={(e) => {
                          e.stopPropagation()
                          // The router nests every session route under a required `:dir` segment
                          // (`/:dir/session/:id`). `params.dir` is the parent's dir and the
                          // subagent lives in the same scope — matching every other session
                          // navigation in the app (message-timeline, session-composer, etc.).
                          navigate(`/${params.dir}/session/${child.id}`)
                        }}
                      >
                        {language.t("session.subagents.open")}
                      </button>
                    </div>
                  </button>
                </div>
              )
            }}
          </For>
        </div>
      </Show>

      {/* ── Oversight section (capability-gated) ── */}
      {/* §3.4.6: when v4MultiAgentRuntime is off hide workspace-level metrics/approval/trace
          but keep the basic list above visible at all times. */}
      <Show when={oversightEnabled() && selectedSessionID()}>
        <div class="border-t border-border-weaker-base">
          <OversightDashboard
            selectedSessionID={selectedSessionID()}
            onSessionSelect={(sid) => setExplicitSelected(sid)}
          />
        </div>
      </Show>
    </div>
  )
}
