import { For, Show, createMemo, createSignal } from "solid-js"
import type { AgentProgressPart } from "@/hooks/use-im-websocket"

interface AgentReasoningCardProps {
  parts: AgentProgressPart[]
  /** True while the agent is still running (drives auto-expand + live label). */
  active: boolean
}

/**
 * Expandable "what the agent is doing" card, fed by the live `agent_progress`
 * stream. Shows the agent's reasoning, tool calls, and drafted text as they
 * happen — the whole point is that the user can watch the agent think in real
 * time instead of staring at a spinner.
 *
 * Behavior:
 *   - While the turn is ACTIVE it auto-expands so the stream is visible without
 *     a click; once the turn finishes it stays whatever the user last set (and
 *     defaults to collapsed) so completed reasoning folds away neatly.
 *   - The user can always toggle manually; a manual toggle wins over auto.
 *   - Parts render in `order`; reasoning/text show streamed text, tools show a
 *     name + lifecycle status.
 */
export function AgentReasoningCard(props: AgentReasoningCardProps) {
  // undefined = follow auto (expanded while active); true/false = user override.
  const [override, setOverride] = createSignal<boolean | undefined>(undefined)
  const expanded = createMemo(() => override() ?? props.active)

  const toolCount = createMemo(() => props.parts.filter((p) => p.kind === "tool").length)
  const summary = createMemo(() => {
    const tools = toolCount()
    if (props.active) return tools > 0 ? `Working · ${tools} tool${tools === 1 ? "" : "s"}` : "Thinking…"
    return tools > 0 ? `Reasoning · ${tools} tool${tools === 1 ? "" : "s"}` : "Reasoning"
  })

  const toolIcon = (status?: string) => {
    switch (status) {
      case "completed":
        return "✓"
      case "error":
        return "✗"
      case "running":
      case "pending":
        return "⏳"
      default:
        return "•"
    }
  }

  const kindLabel = (part: AgentProgressPart) => {
    if (part.kind === "reasoning") return "Reasoning"
    if (part.kind === "tool") return part.tool ?? "Tool"
    return "Draft"
  }

  return (
    <div class="rounded-md border border-border bg-background/50 text-xs">
      <button
        type="button"
        class="flex w-full items-center gap-2 px-2 py-1.5 text-left text-muted-foreground hover:text-foreground"
        onClick={() => setOverride(!expanded())}
        aria-expanded={expanded()}
      >
        <span class={`transition-transform ${expanded() ? "rotate-90" : ""}`}>▸</span>
        <span class="font-medium">{summary()}</span>
        <Show when={props.active}>
          <span class="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
        </Show>
      </button>

      <Show when={expanded()}>
        <div class="space-y-2 border-t border-border px-3 py-2">
          <For each={props.parts}>
            {(part) => (
              <div class="flex flex-col gap-0.5">
                <div class="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  <Show when={part.kind === "tool"} fallback={<span>{kindLabel(part)}</span>}>
                    <span>{toolIcon(part.status)}</span>
                    <span>{kindLabel(part)}</span>
                    <Show when={part.status}>
                      <span class="normal-case text-muted-foreground/70">· {part.status}</span>
                    </Show>
                  </Show>
                </div>
                <Show when={part.kind !== "tool" && part.text}>
                  <div
                    class={`whitespace-pre-wrap break-words ${
                      part.kind === "reasoning" ? "italic text-muted-foreground" : "text-foreground"
                    }`}
                  >
                    {part.text}
                  </div>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
