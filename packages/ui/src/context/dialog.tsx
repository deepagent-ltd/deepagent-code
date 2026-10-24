import {
  createContext,
  createEffect,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  type Owner,
  type ParentProps,
  runWithOwner,
  useContext,
  type JSX,
  startTransition,
  For,
} from "solid-js"
import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { makeEventListener } from "@solid-primitives/event-listener"

type DialogElement = () => JSX.Element
type FocusReturn = { target?: HTMLElement; generation: number }

type Active = {
  id: string
  node: JSX.Element
  dispose: () => void
  owner: Owner
  onClose?: () => void
  setClosing: (closing: boolean) => void
  closing: () => boolean
  returnTarget?: HTMLElement
}

const Context = createContext<ReturnType<typeof init>>()
// Both shared Content wrappers use Kobalte's own unmount-focus event for this exact entry.
const FocusReturnContext = createContext<(event: Event) => void>()

function init() {
  const [stack, setStack] = createSignal<Active[]>([])
  const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined }
  const lock = { value: false }
  const lifetime = { alive: true, generation: 0 }

  onCleanup(() => {
    lifetime.alive = false
    lifetime.generation++
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = undefined
    stack().forEach((item) => item.dispose())
  })

  const requestClose = (id?: string) => {
    const items = stack()
    const current = id ? items.find((item) => item.id === id) : items.at(-1)
    if (!current || lock.value) return
    lock.value = true
    lifetime.generation++
    current.onClose?.()
    current.setClosing(true)

    const closed = current.id
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }

    timer.current = setTimeout(() => {
      timer.current = undefined
      current.dispose()
      setStack((items) => items.filter((item) => item.id !== closed))
      lock.value = false
    }, 100)
  }

  createEffect(() => {
    if (stack().length === 0) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      // An expanded control in the current dialog may consume Escape locally.
      if (
        event.target instanceof Element &&
        event.target.closest("[data-dialog-escape-boundary]") &&
        event.target.closest("[data-dialog-id]")?.getAttribute("data-dialog-id") === stack().at(-1)?.id
      )
        return
      requestClose()
      event.preventDefault()
      event.stopPropagation()
    }

    makeEventListener(window, "keydown", onKeyDown, { capture: true })
  })

  const mount = (
    element: DialogElement,
    owner: Owner,
    focus: FocusReturn,
    onClose: (() => void) | undefined,
    layer: number,
  ) => {
    if (!lifetime.alive || focus.generation !== lifetime.generation) return
    const id = Math.random().toString(36).slice(2)
    const zIndex = 50 + layer * 10
    let dispose: (() => void) | undefined
    let setClosing: ((closing: boolean) => void) | undefined
    let closingSignal: (() => boolean) | undefined
    const closing = { generation: undefined as number | undefined }
    const restoreFocus = (event: Event) => {
      if (event.defaultPrevented) return
      event.preventDefault()
      // Replacements and new opens invalidate a closing entry before its deferred Content cleanup.
      if (!lifetime.alive || closing.generation !== lifetime.generation || !canReturnFocus(focus.target)) return
      const focused = focus.target.ownerDocument.activeElement
      if (
        canReturnFocus(focused) &&
        focused !== focus.target &&
        focused.closest("[data-dialog-id]")?.getAttribute("data-dialog-id") !== id
      )
        return
      const top = stack().findLast((item) => item.id !== id && !item.closing())
      const parent = focus.target.closest("[data-dialog-id]")?.getAttribute("data-dialog-id")
      if (top ? parent !== top.id : parent !== undefined) return
      focus.target.focus({ preventScroll: true })
    }

    const node = runWithOwner(owner, () =>
      createRoot((d: () => void) => {
        dispose = d
        const [closing, setClosingSignal] = createSignal(false)
        setClosing = setClosingSignal
        closingSignal = closing
        return (
          <FocusReturnContext.Provider value={restoreFocus}>
            <Kobalte
              modal
              open={!closing()}
              onOpenChange={(open: boolean) => {
                if (open) return
                requestClose(id)
              }}
            >
              <Kobalte.Portal>
                <Kobalte.Overlay
                  data-component="dialog-overlay"
                  style={{ "z-index": String(zIndex) }}
                  onClick={() => requestClose(id)}
                />
                <div
                  data-dialog-layer={layer}
                  data-dialog-id={id}
                  style={{
                    position: "fixed",
                    inset: "0",
                    "z-index": String(zIndex),
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "center",
                    "pointer-events": "none",
                  }}
                >
                  {element()}
                </div>
              </Kobalte.Portal>
            </Kobalte>
          </FocusReturnContext.Provider>
        )
      }),
    )

    if (!dispose || !setClosing || !closingSignal) return
    const updateClosing = setClosing

    const active: Active = {
      id,
      node,
      dispose,
      owner,
      onClose,
      returnTarget: focus.target,
      setClosing: (value) => {
        if (value) closing.generation = lifetime.generation
        updateClosing(value)
      },
      closing: closingSignal,
    }
    setStack((items) => [...items, active])
  }

  // Finish any close that is still inside its animation window: dispose the closing entries
  // now and drop them from the stack, so a dialog mounted on top never shares the stack with
  // a dead one (whose pending timer would otherwise be cancelled by push/show and leak).
  const settleClosing = () => {
    const closing = stack().filter((item) => item.closing())
    if (closing.length === 0) return
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    lock.value = false
    for (const item of closing) item.dispose()
    const ids = new Set(closing.map((item) => item.id))
    setStack((items) => items.filter((item) => !ids.has(item.id)))
  }

  const prepareFocus = (replace: boolean): FocusReturn => {
    const focused = typeof document === "undefined" ? undefined : document.activeElement
    const parent = focused?.closest("[data-dialog-id]")?.getAttribute("data-dialog-id")
    const current = stack().findLast((item) => !item.closing())
    // A fresh external opener wins; replacement from inside a retiring dialog inherits its external opener.
    const target =
      canReturnFocus(focused) && parent === undefined
        ? focused
        : replace && stack().length
          ? stack()[0]?.returnTarget
          : canReturnFocus(focused) && parent === current?.id
            ? focused
            : stack().at(-1)?.returnTarget
    return { target, generation: ++lifetime.generation }
  }

  const push = (element: DialogElement, owner: Owner, focus: FocusReturn, onClose?: () => void) => {
    if (!lifetime.alive || focus.generation !== lifetime.generation) return
    settleClosing()
    mount(element, owner, focus, onClose, stack().length)
  }

  const show = (element: DialogElement, owner: Owner, focus: FocusReturn, onClose?: () => void) => {
    if (!lifetime.alive || focus.generation !== lifetime.generation) return
    for (const item of stack()) item.dispose()
    setStack([])
    settleClosing()
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    lock.value = false
    mount(element, owner, focus, onClose, 0)
  }

  // The top-most entry that is NOT already closing. A closing dialog is exiting (its stack
  // removal waits out the close animation), so consumers must not treat it as the active
  // dialog: command.tsx gates keybinds on `dialog.active`, and counting an exiting entry
  // makes every reopen pressed during the 100ms close window feel dead.
  const active = () => {
    for (let i = stack().length - 1; i >= 0; i--) {
      if (!stack()[i].closing()) return stack()[i]
    }
    return undefined
  }

  return {
    stack,
    active,
    close: requestClose,
    prepareFocus,
    show,
    push,
  }
}

export function DialogProvider(props: ParentProps) {
  const ctx = init()
  return (
    <Context.Provider value={ctx}>
      {props.children}
      <div data-component="dialog-stack">
        <For each={ctx.stack()}>{(item) => item.node}</For>
      </div>
    </Context.Provider>
  )
}

export function useDialog() {
  const ctx = useContext(Context)
  const owner = getOwner()

  if (!owner) {
    throw new Error("useDialog must be used within a DialogProvider")
  }
  if (!ctx) {
    throw new Error("useDialog must be used within a DialogProvider")
  }

  return {
    get active() {
      return ctx.active()
    },
    show(element: DialogElement, onClose?: () => void) {
      // Exiting dialogs can belong to a different provider scope than this caller.
      const base = ctx.active()?.owner ?? owner
      // Solid may defer the mount; capture the actual caller focus before scheduling it.
      const focus = ctx.prepareFocus(true)
      return startTransition(() => ctx.show(element, base, focus, onClose))
    },
    push(element: DialogElement, onClose?: () => void) {
      const base = ctx.active()?.owner ?? owner
      const focus = ctx.prepareFocus(false)
      return startTransition(() => ctx.push(element, base, focus, onClose))
    },
    close() {
      ctx.close()
    },
  }
}

/** Optional for shared Dialog wrappers also hosted directly by Kobalte. */
export const useDialogFocusReturn = () => useContext(FocusReturnContext)

function canReturnFocus(element: Element | undefined | null): element is HTMLElement {
  if (
    typeof HTMLElement === "undefined" ||
    !(element instanceof HTMLElement) ||
    !element.isConnected ||
    element === element.ownerDocument.body ||
    element === element.ownerDocument.documentElement ||
    element.matches(":disabled") ||
    element.closest('[inert], [hidden], [aria-disabled="true"]')
  )
    return false
  return element.checkVisibility?.({ checkVisibilityCSS: true }) ?? getComputedStyle(element).visibility !== "hidden"
}
