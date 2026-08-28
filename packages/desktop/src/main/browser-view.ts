import { WebContentsView, BrowserWindow, session as electronSession, shell } from "electron"

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

let view: WebContentsView | null = null
let host: BrowserWindow | null = null
let bounds = { x: 0, y: 0, width: 0, height: 0 }
let visible = false

function emit() {
  if (!host || host.isDestroyed() || !view) return
  const wc = view.webContents
  const state: BrowserState = {
    url: wc.getURL(),
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    loading: wc.isLoading(),
  }
  host.webContents.send("browser-state", state)
}

function ensureView(window: BrowserWindow): WebContentsView {
  if (view && !view.webContents.isDestroyed()) return view
  host = window
  const isolated = electronSession.fromPartition(PARTITION)
  view = new WebContentsView({
    webPreferences: {
      session: isolated,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // No preload: the isolated browser exposes NOTHING to the page and the page exposes nothing
      // back. There is deliberately no channel for page content to reach the app.
    },
  })

  const wc = view.webContents
  // Navigation escape guards: window.open / target=_blank go to the OS browser, never a host window.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: "deny" }
  })
  // The host renderer must never be navigated away by page content. (The browser view itself is
  // free to navigate; this protects the app window, which is a different webContents.)
  wc.on("will-navigate", () => emit())
  wc.on("did-navigate", () => emit())
  wc.on("did-navigate-in-page", () => emit())
  wc.on("page-title-updated", () => emit())
  wc.on("did-start-loading", () => emit())
  wc.on("did-stop-loading", () => emit())

  window.contentView.addChildView(view)
  applyBounds()
  return view
}

function applyBounds() {
  if (!view) return
  view.setBounds(visible ? bounds : { x: 0, y: 0, width: 0, height: 0 })
  view.setVisible(visible)
}

export const browserView = {
  show(window: BrowserWindow, rect: { x: number; y: number; width: number; height: number }) {
    const v = ensureView(window)
    bounds = rect
    visible = true
    applyBounds()
    if (!v.webContents.getURL()) void v.webContents.loadURL(HOME)
    emit()
  },
  hide() {
    visible = false
    applyBounds()
  },
  setBounds(rect: { x: number; y: number; width: number; height: number }) {
    bounds = rect
    applyBounds()
  },
  navigate(url: string) {
    if (!view) return
    let target = url.trim()
    if (!target) return
    // Only http(s) — never file:// or app protocols that could reach local resources.
    if (!/^https?:\/\//i.test(target)) target = `https://${target}`
    void view.webContents.loadURL(target).catch(() => {})
  },
  back() {
    if (view?.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack()
  },
  forward() {
    if (view?.webContents.navigationHistory.canGoForward()) view.webContents.navigationHistory.goForward()
  },
  reload() {
    view?.webContents.reload()
  },
  openExternal() {
    const url = view?.webContents.getURL()
    if (url && /^https?:\/\//i.test(url)) void shell.openExternal(url)
  },
  destroy() {
    if (view && host && !host.isDestroyed()) host.contentView.removeChildView(view)
    view = null
    visible = false
  },
}

export type { BrowserState }
