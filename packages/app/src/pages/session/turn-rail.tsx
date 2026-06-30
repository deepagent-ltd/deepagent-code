import { For, Show, createMemo, createSignal } from "solid-js"
import type { Part, UserMessage } from "@deepagent-code/sdk/v2"
import {
  jumpToTurn,
  shouldRenderTurnRail,
  turnPreview,
  turnRailIndexFromPointer,
  turnRailLabel,
  turnRailSegmentWidth,
  type TurnPreview,
} from "./helpers"

export type TurnRailProps = {
  /** Ordered user messages — one segment per turn. */
  userMessages: () => UserMessage[]
  /** Parts for a given message id, used to derive the hover preview. */
  parts: (messageID: string) => Part[]
  /** Currently active turn (single source of truth, shared with hash scroll). */
  activeMessageID: () => string | undefined
  /** Sticky title height in px, so the rail starts below the header. */
  headerOffset: () => number
  /** Jump to a turn (reuses the existing smooth-scroll path). */
  scrollToMessage: (message: UserMessage, behavior?: ScrollBehavior) => void
  /** Sync the active highlight when jumping. */
  setActiveMessage: (message: UserMessage | undefined) => void
}

const previewLabel = (index: number, preview: TurnPreview) => turnRailLabel(index, preview)

export function TurnRail(props: TurnRailProps) {
  // Single-turn / empty conversations render nothing (no visual noise).
  const segments = createMemo(() => props.userMessages())

  // Which segment the pointer is hovering — drives the fisheye magnification
  // and which segment shows its preview. null = no hover. Resolved from the
  // pointer's Y position over the actual ticks band (geometry), not per-tick
  // enter/leave events, so gaps between ticks never drop the hover.
  const [hoverIndex, setHoverIndex] = createSignal<number | null>(null)
  // The ticks are vertically centred and occupy only a slice of the full rail
  // height, so the hit-test must measure that inner band, not the whole nav.
  let ticksRef: HTMLElement | undefined

  const updateHoverFromPointer = (clientY: number) => {
    const el = ticksRef
    if (!el) return
    const rect = el.getBoundingClientRect()
    setHoverIndex(
      turnRailIndexFromPointer({
        pointerY: clientY,
        railTop: rect.top,
        railHeight: rect.height,
        count: segments().length,
      }),
    )
  }

  const jump = (message: UserMessage) =>
    jumpToTurn(message, { setActiveMessage: props.setActiveMessage, scrollToMessage: props.scrollToMessage })

  return (
    <Show when={shouldRenderTurnRail(segments().length)}>
      {/* Absolute-positioned left gutter, vertically centred. The whole column
          is one pointer target: a single onPointerMove maps the cursor's Y onto
          the ticks band, so crossing the gaps between ticks never drops the
          fisheye. Hidden on narrow screens so it never squeezes the content. */}
      <nav
        data-component="turn-rail"
        aria-label="会话轮次导航"
        class="hidden md:flex absolute left-1 z-20 w-8 flex-col items-stretch justify-center pointer-events-auto"
        style={{
          top: `${props.headerOffset()}px`,
          bottom: "0px",
        }}
        onPointerMove={(e) => updateHoverFromPointer(e.clientY)}
        onPointerLeave={() => setHoverIndex(null)}
      >
        <div ref={(el) => (ticksRef = el)} class="flex flex-col items-start gap-1.5">
          <For each={segments()}>
            {(message, index) => {
              const preview = createMemo(() => turnPreview(props.parts(message.id)))
              const active = createMemo(() => props.activeMessageID() === message.id)
              const hovered = createMemo(() => hoverIndex() === index())
              const label = createMemo(() => previewLabel(index(), preview()))
              const width = createMemo(() => turnRailSegmentWidth({ index: index(), hoverIndex: hoverIndex() }))
              const hasPreview = createMemo(() => !!(preview().title || preview().body))

              return (
                <button
                  type="button"
                  data-slot="turn-rail-segment"
                  data-active={active() ? "true" : undefined}
                  data-hovered={hovered() ? "true" : undefined}
                  aria-label={label()}
                  aria-current={active() ? "true" : undefined}
                  class="group relative flex items-center justify-start h-2 w-full bg-transparent border-none p-0 cursor-pointer outline-none"
                  onFocus={() => setHoverIndex(index())}
                  onClick={() => jump(message)}
                >
                  {/* The tick. Width follows the fisheye curve; colour is fixed —
                      only length changes on hover, per design. */}
                  <span
                    class="block rounded-full transition-[width] duration-100 ease-out"
                    classList={{
                      "h-[3px]": active(),
                      "h-[2px]": !active(),
                    }}
                    style={{
                      width: `${width()}px`,
                      background: active()
                        ? "var(--icon-strong-base, var(--icon-base))"
                        : "var(--icon-weak-base, var(--border-strong-base))",
                    }}
                  />
                  {/* Preview bubble: only for the segment the pointer rests on. */}
                  <Show when={hovered() && hasPreview()}>
                    <div
                      data-slot="turn-rail-preview"
                      class="absolute left-full top-1/2 -translate-y-1/2 ml-2 z-10 w-72 max-w-72 rounded-[8px] border border-border-weak-base bg-surface-raised-stronger-non-alpha px-3 py-2 shadow-md text-left"
                    >
                      <Show when={preview().title}>
                        <div class="text-12-medium text-text-strong truncate">{preview().title}</div>
                      </Show>
                      <Show when={preview().body}>
                        <div class="mt-1 text-12-regular text-text-weak line-clamp-3">{preview().body}</div>
                      </Show>
                    </div>
                  </Show>
                </button>
              )
            }}
          </For>
        </div>
      </nav>
    </Show>
  )
}
