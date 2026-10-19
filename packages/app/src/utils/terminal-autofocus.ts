import type { Terminal } from "ghostty-web"

export function terminalAutoFocusAllowed() {
  const active = document.activeElement
  return !(
    active instanceof HTMLElement &&
    active.matches('[role="tab"][data-work-panel-keyboard-focus="true"]') &&
    active.closest('[data-slot="work-panel-tabs"]') &&
    !active.closest('[inert], [aria-hidden="true"]')
  )
}

export function terminalAutoFocusRequest(root: () => HTMLElement | undefined) {
  const allowed = terminalAutoFocusAllowed()
  const origin = document.activeElement
  return () =>
    allowed &&
    terminalAutoFocusAllowed() &&
    (document.activeElement === origin ||
      document.activeElement === document.body ||
      !!root()?.contains(document.activeElement))
}

export function openTerminalWithoutAutoFocus(terminal: Pick<Terminal, "open" | "focus">, parent: HTMLElement) {
  const own = Object.getOwnPropertyDescriptor(terminal, "focus")
  // Ghostty open() calls focus() internally, before DAC can apply its focus owner.
  Object.defineProperty(terminal, "focus", { configurable: true, writable: true, value: () => {} })
  try {
    terminal.open(parent)
  } finally {
    if (own) Object.defineProperty(terminal, "focus", own)
    else Reflect.deleteProperty(terminal, "focus")
  }
}
