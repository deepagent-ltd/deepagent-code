/**
 * Pure decision logic for close-to-tray behavior, extracted so it can be unit-tested without the
 * Electron runtime.
 *
 * Closing the main window hides it to the tray ONLY when all of:
 *  - an explicit quit is not in progress (`isQuitting` is false)
 *  - a system tray was successfully created (`trayAvailable` is true)
 *
 * Without a tray (e.g. Linux GNOME default, which ships no StatusNotifierItem host), closing must
 * quit normally — otherwise the window would be hidden with no way to recover it.
 */
export function shouldHideOnClose(input: { isQuitting: boolean; trayAvailable: boolean }): boolean {
  return !input.isQuitting && input.trayAvailable
}
