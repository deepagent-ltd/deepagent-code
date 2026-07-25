import { describe, expect, test } from "bun:test"
import { shouldHideOnClose } from "./close-to-tray"

// Covers the multi-platform close-to-tray gating without the Electron runtime. The same decision
// runs in windows.ts on every window "close" event.

describe("shouldHideOnClose", () => {
  test("hides to tray when not quitting and a tray is available", () => {
    expect(shouldHideOnClose({ isQuitting: false, trayAvailable: true })).toBe(true)
  })

  test("quits normally (does not hide) when no tray is available — Linux GNOME fallback", () => {
    // This is the critical Linux case: without a tray host, hiding would strand the window.
    expect(shouldHideOnClose({ isQuitting: false, trayAvailable: false })).toBe(false)
  })

  test("quits normally when an explicit quit is in progress, even with a tray", () => {
    // tray "Quit", Cmd+Q, and before-quit all set isQuitting=true to bypass close-to-tray.
    expect(shouldHideOnClose({ isQuitting: true, trayAvailable: true })).toBe(false)
  })

  test("quits normally when both quitting and no tray", () => {
    expect(shouldHideOnClose({ isQuitting: true, trayAvailable: false })).toBe(false)
  })
})
