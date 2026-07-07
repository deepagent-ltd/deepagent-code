import { batch, createMemo, onCleanup, onMount, type Accessor, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import type { Part, UserMessage } from "@deepagent-code/sdk/v2"
import { same } from "@/utils/same"

export type TurnPreview = { title?: string; body?: string }

const TURN_PREVIEW_TITLE_MAX = 80
const TURN_PREVIEW_BODY_MAX = 160

const truncatePreview = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value

/**
 * Derive a short, human-readable preview for a single turn (= one user message)
 * from its parts: first line of the first non-synthetic text part becomes the
 * title, the rest of that part becomes a collapsed, truncated body. Synthetic /
 * comment parts (and ignored / empty ones) are skipped. Pure + side-effect free
 * so the turn rail can call it per segment.
 */
export function turnPreview(parts: Part[]): TurnPreview {
  const part = parts.find((p) => p.type === "text" && !p.synthetic && !p.ignored && !!p.text?.trim())
  if (!part || part.type !== "text") return {}

  const lines = part.text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

  const head = lines[0]
  if (!head) return {}

  const rest = lines.slice(1).join(" ").trim()
  return {
    title: truncatePreview(head, TURN_PREVIEW_TITLE_MAX),
    body: rest ? truncatePreview(rest, TURN_PREVIEW_BODY_MAX) : undefined,
  }
}

/** The turn rail only shows when there's more than one turn to navigate. */
export const shouldRenderTurnRail = (turnCount: number) => turnCount > 1

export const forkCutoffMessageID = (messages: { id: string }[], messageID: string) => {
  const index = messages.findIndex((message) => message.id === messageID)
  if (index < 0) return undefined
  return messages[index + 1]?.id
}

/**
 * Build the reply-bubble "fork" action. The clicked bubble is the anchor, so
 * the new session includes messages through that bubble. Session.fork treats
 * `messageID` as the first message NOT copied, so the UI passes the next
 * message as the cutoff; no next message means a full-history fork.
 */
export const createForkAction =
  (deps: {
    open: (component: DialogForkComponent) => void
    loadDialog?: () => Promise<{ DialogFork: DialogForkComponent }>
    messages?: (sessionID: string) => { id: string }[]
    fork?: (input: { sessionID: string; messageID?: string }) => Promise<{ id: string } | undefined>
    navigate?: (sessionID: string) => void
    onError?: (error: unknown) => void
  }) =>
  (input?: { sessionID: string; messageID: string }) => {
    if (input && deps.messages && deps.fork && deps.navigate) {
      const navigate = deps.navigate
      return deps
        .fork({
          sessionID: input.sessionID,
          messageID: forkCutoffMessageID(deps.messages(input.sessionID), input.messageID),
        })
        .then((session) => {
          if (session) navigate(session.id)
        })
        .catch((error: unknown) => deps.onError?.(error))
    }

    const load = deps.loadDialog ?? (() => import("@/components/dialog-fork"))
    return load().then((mod) => deps.open(mod.DialogFork))
  }

type DialogForkComponent = Component

/**
 * Fisheye width (px) for a turn rail segment given how far it sits from the
 * hovered segment. The hovered segment grows to `peak`; neighbours shrink
 * linearly back to `base` over `radius` segments. With no hover (hoverIndex
 * null) every segment stays at `base`. Pure so the magnification curve is
 * testable without rendering.
 */
export const turnRailSegmentWidth = (input: {
  index: number
  hoverIndex: number | null
  base?: number
  peak?: number
  radius?: number
}) => {
  const base = input.base ?? 8
  const peak = input.peak ?? 28
  const radius = input.radius ?? 3
  if (input.hoverIndex === null) return base

  const distance = Math.abs(input.index - input.hoverIndex)
  if (distance > radius) return base

  // Linear falloff: distance 0 → peak, distance == radius → base.
  const t = distance / radius
  return Math.round(peak - (peak - base) * t)
}

/**
 * Map a pointer's vertical position over the turn rail to a segment index.
 * The rail's full height is split into `count` equal bands so every pixel —
 * including the gaps between ticks and the area around magnified ticks — maps
 * to exactly one segment. This is what keeps the fisheye from collapsing when
 * the pointer crosses a gap. Returns null only when there are no segments.
 * Pure so the geometry is testable without a DOM.
 */
export const turnRailIndexFromPointer = (input: {
  pointerY: number
  railTop: number
  railHeight: number
  count: number
}) => {
  if (input.count <= 0) return null
  if (input.railHeight <= 0) return 0
  const offset = input.pointerY - input.railTop
  const band = input.railHeight / input.count
  const index = Math.floor(offset / band)
  // Clamp so positions just outside the band edges still resolve to an end
  // segment rather than dropping the hover.
  return Math.min(input.count - 1, Math.max(0, index))
}

/** aria-label for a turn rail segment: "跳到第 N 轮：<预览>". */
export const turnRailLabel = (index: number, preview: TurnPreview) => {
  const text = preview.title ?? preview.body
  return `跳到第 ${index + 1} 轮${text ? `：${text}` : ""}`
}

/**
 * Resolve which turn the rail highlights. A turn the user explicitly pinned
 * (click / hash jump, still in sync with the latest scroll gesture) wins;
 * otherwise follow the scroll position. Falls back to the pinned id. This is
 * the single highlight source — no competing "active turn" state.
 */
export const resolveActiveTurnId = (input: {
  pinnedId: string | undefined
  pinnedFresh: boolean
  scrollId: string | undefined
}) => (input.pinnedId && input.pinnedFresh ? input.pinnedId : (input.scrollId ?? input.pinnedId))

/**
 * Clicking a turn rail segment: sync the active highlight first (single source
 * of truth shared with hash scroll), then jump via the existing smooth-scroll
 * path. Pure orchestration so the wiring is testable without rendering.
 */
export const jumpToTurn = (
  message: UserMessage,
  actions: {
    setActiveMessage: (message: UserMessage | undefined) => void
    scrollToMessage: (message: UserMessage, behavior?: ScrollBehavior) => void
  },
) => {
  actions.setActiveMessage(message)
  actions.scrollToMessage(message, "smooth")
}

const emptyTabs: string[] = []

type Tabs = {
  active: Accessor<string | undefined>
  all: Accessor<string[]>
}

type TabsInput = {
  tabs: Accessor<Tabs>
  pathFromTab: (tab: string) => string | undefined
  normalizeTab: (tab: string) => string
  review?: Accessor<boolean>
  hasReview?: Accessor<boolean>
}

export const getSessionKey = (dir: string | undefined, id: string | undefined) => `${dir ?? ""}${id ? `/${id}` : ""}`

export const createSessionTabs = (input: TabsInput) => {
  const review = input.review ?? (() => false)
  const hasReview = input.hasReview ?? (() => false)
  const contextOpen = createMemo(() => input.tabs().active() === "context" || input.tabs().all().includes("context"))
  const openedTabs = createMemo(
    () => {
      const seen = new Set<string>()
      return input
        .tabs()
        .all()
        .flatMap((tab) => {
          if (tab === "context" || tab === "review") return []
          const value = input.pathFromTab(tab) ? input.normalizeTab(tab) : tab
          if (seen.has(value)) return []
          seen.add(value)
          return [value]
        })
    },
    emptyTabs,
    { equals: same },
  )
  const activeTab = createMemo(() => {
    const active = input.tabs().active()
    if (active === "context") return active
    if (active === "review" && review()) return active
    if (active && input.pathFromTab(active)) return input.normalizeTab(active)

    const first = openedTabs()[0]
    if (first) return first
    if (contextOpen()) return "context"
    if (review() && hasReview()) return "review"
    return "empty"
  })
  const activeFileTab = createMemo(() => {
    const active = activeTab()
    if (!openedTabs().includes(active)) return
    return active
  })
  const closableTab = createMemo(() => {
    const active = activeTab()
    if (active === "context") return active
    if (!openedTabs().includes(active)) return
    return active
  })

  return {
    contextOpen,
    openedTabs,
    activeTab,
    activeFileTab,
    closableTab,
  }
}

export const focusTerminalById = (id: string) => {
  const wrapper = document.getElementById(`terminal-wrapper-${id}`)
  const terminal = wrapper?.querySelector('[data-component="terminal"]')
  if (!(terminal instanceof HTMLElement)) return false

  const textarea = terminal.querySelector("textarea")
  if (textarea instanceof HTMLTextAreaElement) {
    textarea.focus()
    return true
  }

  terminal.focus()
  terminal.dispatchEvent(
    typeof PointerEvent === "function"
      ? new PointerEvent("pointerdown", { bubbles: true, cancelable: true })
      : new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
  )
  return true
}

const skip = new Set(["Alt", "Control", "Meta", "Shift"])

export const shouldFocusTerminalOnKeyDown = (event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">) => {
  if (skip.has(event.key)) return false
  return !(event.ctrlKey || event.metaKey || event.altKey)
}

export const createOpenReviewFile = (input: {
  showAllFiles: () => void
  tabForPath: (path: string) => string
  openTab: (tab: string) => void
  setActive: (tab: string) => void
  loadFile: (path: string) => any | Promise<void>
}) => {
  return (path: string) => {
    batch(() => {
      input.showAllFiles()
      const maybePromise = input.loadFile(path)
      const open = () => {
        const tab = input.tabForPath(path)
        input.openTab(tab)
        input.setActive(tab)
      }
      if (maybePromise instanceof Promise) void maybePromise.then(open)
      else open()
    })
  }
}

export const createOpenSessionFileTab = (input: {
  normalizeTab: (tab: string) => string
  openTab: (tab: string) => void
  pathFromTab: (tab: string) => string | undefined
  loadFile: (path: string) => void
  // Called after the file is loaded/opened so the caller can surface the preview (e.g. focus the
  // files panel and leave "file tree" mode). Previously this forced the review panel open, which
  // only renders diffs — so clicking a non-changed file appeared to do nothing (V3.6 P0-1).
  onOpen?: () => void
  setActive: (tab: string) => void
}) => {
  return (value: string) => {
    const next = input.normalizeTab(value)
    input.openTab(next)

    const path = input.pathFromTab(next)
    if (!path) return

    input.loadFile(path)
    input.onOpen?.()
    input.setActive(next)
  }
}

export const getTabReorderIndex = (tabs: readonly string[], from: string, to: string) => {
  const fromIndex = tabs.indexOf(from)
  const toIndex = tabs.indexOf(to)
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return undefined
  return toIndex
}

export const createSizing = () => {
  const [state, setState] = createStore({ active: false })
  let t: number | undefined

  const stop = () => {
    if (t !== undefined) {
      clearTimeout(t)
      t = undefined
    }
    setState("active", false)
  }

  const start = () => {
    if (t !== undefined) {
      clearTimeout(t)
      t = undefined
    }
    setState("active", true)
  }

  onMount(() => {
    makeEventListener(window, "pointerup", stop)
    makeEventListener(window, "pointercancel", stop)
    makeEventListener(window, "blur", stop)
  })

  onCleanup(() => {
    if (t !== undefined) clearTimeout(t)
  })

  return {
    active: () => state.active,
    start,
    touch() {
      start()
      t = window.setTimeout(stop, 120)
    },
  }
}

export type Sizing = ReturnType<typeof createSizing>
