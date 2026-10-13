import { WebContentsView, BrowserWindow, ipcMain, session, shell } from "electron"
import type { IpcMainInvokeEvent } from "electron"

// U7 (S1 §P2): a FULLY ISOLATED in-app browser. Hard rules:
//  - Runs on its OWN session partition ("persist:isolated-browser") — cookies/localStorage/cache are
//    completely separate from the app renderer's session.
//  - NO content bridge: there is intentionally NO IPC that reads the page DOM/text/title/HTML back
//    into the main process or the agent. The only IPC is NAVIGATION CONTROL (load/back/forward/
//    reload) + state notifications (url/title/canGoBack for the address bar). Page content never
//    crosses into the agent context. This is the architectural guarantee, not a UI choice.
//  - Navigation escape is blocked: window.open and cross-window navigation are rerouted to the OS
//    browser; the host renderer can never be navigated away.
//  - Node disabled, contextIsolation + sandbox on, webSecurity on.

const PARTITION = "persist:isolated-browser"
const HOME = "about:blank"

type BrowserState = { url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean }

type Entry = {
  view: WebContentsView
  bounds: { x: number; y: number; width: number; height: number }
  visible: boolean
  closed: () => void
  closing?: Promise<void>
}
// Human browser cookies retain the existing profile. Views and navigation belong to their
// actual host window; Agent browsing must use a separate empty profile and authority.
const views = new WeakMap<BrowserWindow, Entry>()
// Actual contents, including an unconfirmed close, keep their original host and slot alive.
// Weak window membership alone cannot own a physical WebContents after a close timeout.
const custody = new Set<Entry>()
const MAX_BROWSER_VIEWS = 32

function emit(host: BrowserWindow, entry: Entry) {
  if (host.isDestroyed() || views.get(host) !== entry || entry.closing || entry.view.webContents.isDestroyed()) return
  const wc = entry.view.webContents
  const state: BrowserState = {
    url: wc.getURL(),
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    loading: wc.isLoading(),
  }
  host.webContents.send("browser-state", state)
}

function ensureView(window: BrowserWindow): Entry {
  const existing = views.get(window)
  if (existing && !existing.view.webContents.isDestroyed()) {
    if (existing.closing) throw new Error("Browser contents destruction is unconfirmed")
    return existing
  }
  if (custody.size >= MAX_BROWSER_VIEWS) throw new Error("Browser view capacity is exhausted")
  const view = new WebContentsView({
    webPreferences: {
      session: session.fromPartition(PARTITION),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // No preload: the isolated browser exposes NOTHING to the page and the page exposes nothing
      // back. There is deliberately no channel for page content to reach the app.
    },
  })
  const closed = () => {
    if (views.get(window)?.view === view)
      void browserView.destroy(window).catch((error) => console.error("Browser view cleanup failed", error))
  }
  const entry: Entry = { view, bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false, closed }
  views.set(window, entry)
  custody.add(entry)

  const wc = view.webContents
  wc.once("destroyed", () => {
    // A late confirmation retires only this physical incarnation, never its replacement.
    if (views.get(window) === entry) views.delete(window)
    window.removeListener("closed", entry.closed)
    custody.delete(entry)
  })
  // Navigation escape guards: window.open / target=_blank go to the OS browser, never a host window.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: "deny" }
  })
  // The host renderer must never be navigated away by page content. (The browser view itself is
  // free to navigate; this protects the app window, which is a different webContents.)
  wc.on("will-navigate", () => emit(window, entry))
  wc.on("did-navigate", () => emit(window, entry))
  wc.on("did-navigate-in-page", () => emit(window, entry))
  wc.on("page-title-updated", () => emit(window, entry))
  wc.on("did-start-loading", () => emit(window, entry))
  wc.on("did-stop-loading", () => emit(window, entry))
  // Capture this incarnation: a late close event must never close a replacement view.
  window.once("closed", closed)

  window.contentView.addChildView(view)
  applyBounds(entry)
  return entry
}

function applyBounds(entry: Entry) {
  if (entry.closing || entry.view.webContents.isDestroyed()) return
  entry.view.setBounds(entry.visible ? entry.bounds : { x: 0, y: 0, width: 0, height: 0 })
  entry.view.setVisible(entry.visible)
}

export const browserView = {
  show(window: BrowserWindow, rect: { x: number; y: number; width: number; height: number }) {
    if (window.isDestroyed()) return
    const entry = ensureView(window)
    entry.bounds = rect
    entry.visible = true
    if (!window.contentView.children.includes(entry.view)) window.contentView.addChildView(entry.view)
    applyBounds(entry)
    if (!entry.view.webContents.getURL()) void entry.view.webContents.loadURL(HOME).catch(() => {})
    emit(window, entry)
  },
  hide(window: BrowserWindow) {
    const entry = views.get(window)
    if (!entry) return
    entry.visible = false
    // A hidden attached child can occlude its host after a renderer reload on macOS.
    // Detach the same physical view; its contents and custody survive until real close.
    if (window.contentView.children.includes(entry.view)) window.contentView.removeChildView(entry.view)
    applyBounds(entry)
  },
  setBounds(window: BrowserWindow, rect: { x: number; y: number; width: number; height: number }) {
    const entry = views.get(window)
    if (!entry) return
    entry.bounds = rect
    applyBounds(entry)
  },
  navigate(window: BrowserWindow, url: string) {
    const entry = views.get(window)
    const target = url.trim()
    if (!entry || entry.closing || entry.view.webContents.isDestroyed() || !target) return
    // Only http(s) — never file:// or app protocols that could reach local resources.
    void entry.view.webContents.loadURL(/^https?:\/\//i.test(target) ? target : `https://${target}`).catch(() => {})
  },
  back(window: BrowserWindow) {
    const entry = views.get(window)
    const wc = !entry?.closing ? entry?.view.webContents : undefined
    if (wc && !wc.isDestroyed() && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  },
  forward(window: BrowserWindow) {
    const entry = views.get(window)
    const wc = !entry?.closing ? entry?.view.webContents : undefined
    if (wc && !wc.isDestroyed() && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
  },
  reload(window: BrowserWindow) {
    const entry = views.get(window)
    const wc = !entry?.closing ? entry?.view.webContents : undefined
    if (wc && !wc.isDestroyed()) wc.reload()
  },
  openExternal(window: BrowserWindow) {
    const entry = views.get(window)
    const wc = !entry?.closing ? entry?.view.webContents : undefined
    const url = wc && !wc.isDestroyed() ? wc.getURL() : undefined
    if (url && /^https?:\/\//i.test(url)) void shell.openExternal(url)
  },
  async destroy(window: BrowserWindow) {
    const entry = views.get(window)
    if (!entry) return
    if (entry.closing) return entry.closing
    if (!window.isDestroyed() && window.contentView.children.includes(entry.view))
      window.contentView.removeChildView(entry.view)
    const wc = entry.view.webContents
    if (wc.isDestroyed()) return
    // Closing is issued once. A timeout retains the original contents, listener and capacity;
    // only its actual destroyed event makes a new physical view eligible for this host.
    entry.closing = new Promise<void>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        wc.removeListener("destroyed", finish)
        reject(new Error("Browser contents did not confirm destruction"))
      }, 5000)
      wc.once("destroyed", finish)
      wc.close({ waitForBeforeUnload: false })
    })
    return entry.closing
  },
}

export type { BrowserState }

/** Navigation-only IPC. The page view and subframes cannot control a host window. */
export function registerBrowserViewIpc() {
  ipcMain.handle("browser-show", (event: IpcMainInvokeEvent, rect: Entry["bounds"]) => {
    const window = browserWindow(event)
    if (window) browserView.show(window, rect)
  })
  ipcMain.handle("browser-hide", (event: IpcMainInvokeEvent) => {
    const window = browserWindow(event)
    if (window) browserView.hide(window)
  })
  ipcMain.handle("browser-set-bounds", (event: IpcMainInvokeEvent, rect: Entry["bounds"]) => {
    const window = browserWindow(event)
    if (window) browserView.setBounds(window, rect)
  })
  ipcMain.handle("browser-navigate", (event: IpcMainInvokeEvent, url: string) => {
    const window = browserWindow(event)
    if (window) browserView.navigate(window, url)
  })
  ipcMain.handle("browser-back", (event: IpcMainInvokeEvent) => {
    const window = browserWindow(event)
    if (window) browserView.back(window)
  })
  ipcMain.handle("browser-forward", (event: IpcMainInvokeEvent) => {
    const window = browserWindow(event)
    if (window) browserView.forward(window)
  })
  ipcMain.handle("browser-reload", (event: IpcMainInvokeEvent) => {
    const window = browserWindow(event)
    if (window) browserView.reload(window)
  })
  ipcMain.handle("browser-open-external", (event: IpcMainInvokeEvent) => {
    const window = browserWindow(event)
    if (window) browserView.openExternal(window)
  })
}

function browserWindow(event: IpcMainInvokeEvent) {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (
    !window ||
    window.isDestroyed() ||
    window.webContents !== event.sender ||
    event.senderFrame !== event.sender.mainFrame
  )
    return
  return window
}
