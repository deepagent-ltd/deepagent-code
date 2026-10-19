import { createEffect, onCleanup, type Accessor, type JSX } from "solid-js"
import { createStore } from "solid-js/store"

/** Keep a portalled Session card inside the conversation that owns its trigger. */
export function useSessionOverviewLayout(
  trigger: Accessor<HTMLElement | undefined>,
  kind: "context" | "tasks",
  opened: Accessor<boolean>,
) {
  const [bounds, setBounds] = createStore({ width: kind === "context" ? 320 : 380, height: 0, offset: 0, hidden: true })
  createEffect(() => {
    if (!opened()) return
    const element = trigger()
    if (!element) return
    const panel = element.closest<HTMLElement>("[data-session-overview-scope]")
    const measure = () => {
      const viewport = {
        left: window.visualViewport?.offsetLeft ?? 0,
        top: window.visualViewport?.offsetTop ?? 0,
        width: window.visualViewport?.width ?? (document.documentElement.clientWidth || window.innerWidth),
        height: window.visualViewport?.height ?? (document.documentElement.clientHeight || window.innerHeight),
      }
      const scope = panel?.getBoundingClientRect()
      const anchor = element.getBoundingClientRect()
      // A real hidden workbench must not leave its portal floating over another panel.
      // Scope-less isolated components still use viewport bounds.
      if (panel && (!scope?.width || !scope.height || !anchor.width || !anchor.height)) {
        setBounds({ width: 0, height: 0, offset: 0, hidden: true })
        return
      }
      const left = Math.max(viewport.left, scope?.width ? scope.left : viewport.left) + 12
      const right =
        Math.min(viewport.left + viewport.width, scope?.width ? scope.right : viewport.left + viewport.width) - 12
      const top = Math.max(viewport.top, scope?.height ? scope.top : viewport.top)
      const bottom =
        Math.min(viewport.top + viewport.height, scope?.height ? scope.bottom : viewport.top + viewport.height) - 12
      // bottom-end is kept deliberately: short cards scroll instead of flipping over the Session header.
      const end = anchor.width ? Math.min(anchor.right, right) : right
      setBounds({
        hidden: false,
        width: Math.max(0, Math.floor(Math.min(kind === "context" ? 320 : 380, end - left))),
        offset: anchor.width ? Math.min(0, right - anchor.right) : 0,
        height: Math.max(
          0,
          Math.floor(Math.min(kind === "context" ? 480 : 560, (bottom - top) * 0.7, bottom - (anchor.bottom + 4))),
        ),
      })
    }
    measure()
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure)
    observer?.observe(element)
    if (panel) observer?.observe(panel)
    const scroll = (event: Event) => {
      if (event.target instanceof Node && !event.target.contains(element)) return
      measure()
    }
    window.addEventListener("resize", measure)
    window.addEventListener("scroll", scroll, true)
    window.visualViewport?.addEventListener("resize", measure)
    window.visualViewport?.addEventListener("scroll", measure)
    onCleanup(() => {
      observer?.disconnect()
      window.removeEventListener("resize", measure)
      window.removeEventListener("scroll", scroll, true)
      window.visualViewport?.removeEventListener("resize", measure)
      window.visualViewport?.removeEventListener("scroll", measure)
    })
  })
  return (): JSX.CSSProperties => ({
    width: `${bounds.width}px`,
    visibility: bounds.hidden ? "hidden" : "visible",
    "pointer-events": bounds.hidden ? "none" : "auto",
    "max-width": "min(100vw - 24px, var(--kb-popper-content-available-width, 100vw))",
    "max-height": bounds.height ? `min(${bounds.height}px, var(--kb-popper-content-available-height, 100vh))` : "0px",
    translate: `${bounds.offset}px 0`,
    "min-width": "0",
    "min-height": "0",
    display: "flex",
    "flex-direction": "column",
    overflow: "hidden",
    "border-radius": "20px",
  })
}
