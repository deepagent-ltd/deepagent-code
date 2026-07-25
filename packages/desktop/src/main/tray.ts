import { app, BrowserWindow, Menu, Tray, nativeImage } from "electron"
import { join } from "node:path"
import { write as writeLog } from "./logging"
import { iconsDir, setIsQuitting } from "./windows"

let tray: Tray | null = null

/**
 * Create the system tray icon. Returns true on success.
 *
 * Tray support is optional by platform: Linux GNOME (default) ships no StatusNotifierItem/AppIndicator
 * host, and `new Tray()` may throw or produce a no-op tray there. Callers must only enable close-to-tray
 * behavior when this returns true, otherwise a hidden window would be unrecoverable.
 */
export function createTray(getMainWindow: () => BrowserWindow | null): boolean {
  if (tray) return true

  const source = nativeImage.createFromPath(join(iconsDir(), "32x32.png"))
  if (source.isEmpty()) {
    // The tray icon failed to load (missing resource or decode error). Creating a Tray from an
    // empty image can still succeed on some platforms (notably Linux), which would then enable
    // close-to-tray with an invisible icon — hiding the window with no way to recover it.
    writeLog("tray", "tray icon image is empty, skipping tray creation", {}, "warn")
    return false
  }
  const icon = source.resize({ width: 22, height: 22 })

  try {
    tray = new Tray(icon)
  } catch (error) {
    writeLog("tray", "failed to create tray", { error }, "warn")
    tray = null
    return false
  }

  tray.setToolTip("DeepAgent Code")

  const menu = Menu.buildFromTemplate([
    { label: "Show DeepAgent Code", click: () => showMainWindow(getMainWindow) },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        setIsQuitting(true)
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)
  tray.on("click", () => showMainWindow(getMainWindow))
  return true
}

function showMainWindow(getMainWindow: () => BrowserWindow | null): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  if (win.isVisible()) {
    win.focus()
    return
  }
  win.show()
  win.focus()
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
