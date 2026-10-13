import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { once } from "node:events"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { app, BrowserWindow, webContents } from "electron"
import type { WebContents } from "electron"
import { browserView, registerBrowserViewIpc } from "../browser-view"

app.setPath("userData", process.env.DAC_BROWSER_TEST_ROOT!)
async function main() {
  await app.whenReady()
  registerBrowserViewIpc()
  // Trusted fixture hosts drive real ipcRenderer. Actual page views retain sandbox preferences.
  const first = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: false,
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      contextIsolation: false,
    },
  })
  const second = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: false, nodeIntegration: true, contextIsolation: false },
  })
  await first.loadURL('data:text/html,<iframe srcdoc="Frame fixture"></iframe>')
  await second.loadURL("data:text/html,Second host")
  const rect = { x: 0, y: 0, width: 320, height: 240 }
  browserView.show(first, rect)
  const firstView = webContents
    .getAllWebContents()
    .find((item) => item.id !== first.webContents.id && item.id !== second.webContents.id)!
  browserView.show(second, rect)
  const secondView = webContents
    .getAllWebContents()
    .find((item) => item.id !== first.webContents.id && item.id !== second.webContents.id && item.id !== firstView.id)
  const initial = {
    firstChildren: first.contentView.children.length,
    secondChildren: second.contentView.children.length,
    separateContents: secondView !== undefined && firstView.id !== secondView.id,
  }
  const originalClosedListeners = first.listenerCount("closed")
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" })
    response.end(`<title>${request.url}</title><body>Isolated lifecycle fixture</body>`)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  assert(secondView)
  const firstLoaded = waitForURL(firstView, `${origin}/first`)
  await first.webContents.executeJavaScript(
    `require('electron').ipcRenderer.invoke('browser-navigate', ${JSON.stringify(`${origin}/first`)})`,
  )
  await firstLoaded
  const secondLoaded = waitForURL(secondView, `${origin}/second`)
  await second.webContents.executeJavaScript(
    `require('electron').ipcRenderer.invoke('browser-navigate', ${JSON.stringify(`${origin}/second`)})`,
  )
  await secondLoaded
  await first.webContents.mainFrame.frames[0].executeJavaScript(
    "require('electron').ipcRenderer.invoke('browser-hide')",
  )
  const subframeRejected = first.contentView.children[0].getBounds().width === rect.width
  await first.webContents.executeJavaScript("require('electron').ipcRenderer.invoke('browser-hide')")
  const navigation = {
    firstURL: firstView.getURL(),
    secondURL: secondView.getURL(),
    firstHidden: first.contentView.children.length === 0 && !firstView.isDestroyed(),
    secondVisible: second.contentView.children[0].getBounds().width === rect.width,
  }
  browserView.show(first, rect)
  assert.equal(first.contentView.children.length, 1)
  assert.equal(firstView.getURL(), `${origin}/first`)
  browserView.show(first, rect)
  assert.equal(first.contentView.children.length, 1)
  browserView.hide(first)
  assert.equal(first.contentView.children.length, 0)
  assert.equal(firstView.isDestroyed(), false)
  await browserView.destroy(first)
  const afterFirstDestroy = {
    firstDestroyed: firstView.isDestroyed(),
    secondAlive: secondView !== undefined && !secondView.isDestroyed(),
    firstChildren: first.contentView.children.length,
    secondChildren: second.contentView.children.length,
    listenerReleased: first.listenerCount("closed") === originalClosedListeners - 1,
  }
  browserView.show(first, rect)
  const replacement = webContents
    .getAllWebContents()
    .find(
      (item) =>
        item.id !== first.webContents.id &&
        item.id !== second.webContents.id &&
        item.id !== secondView?.id &&
        item.id !== firstView.id,
    )
  const closed = replacement ? once(replacement, "destroyed") : Promise.resolve()
  first.destroy()
  await closed
  const afterHostClose = {
    replacementDestroyed: replacement !== undefined && replacement.isDestroyed(),
    secondAlive: secondView !== undefined && !secondView.isDestroyed(),
  }
  await browserView.destroy(second)
  const final = { secondDestroyed: secondView !== undefined && secondView.isDestroyed() }
  // Controlled close fault on a real physical WebContents: timeout must retain custody.
  browserView.show(second, rect)
  const retainedView = webContents.getAllWebContents().find((item) => item.id !== second.webContents.id)!
  const originalClose = retainedView.close
  let closeCalls = 0
  retainedView.close = () => {
    closeCalls++
  }
  await assert.rejects(browserView.destroy(second), /did not confirm destruction/)
  assert.equal(retainedView.isDestroyed(), false)
  assert.throws(() => browserView.show(second, rect), /destruction is unconfirmed/)
  await assert.rejects(browserView.destroy(second), /did not confirm destruction/)
  assert.equal(closeCalls, 1)
  assert.equal(webContents.getAllWebContents().filter((item) => item.id !== second.webContents.id).length, 1)
  const heldHosts = Array.from({ length: 31 }, () => new BrowserWindow({ show: false }))
  heldHosts.forEach((host) => browserView.show(host, rect))
  const overflowHost = new BrowserWindow({ show: false })
  assert.throws(() => browserView.show(overflowHost, rect), /capacity is exhausted/)
  const confirmed = once(retainedView, "destroyed")
  retainedView.close = originalClose
  retainedView.close({ waitForBeforeUnload: false })
  await confirmed
  browserView.show(overflowHost, rect)
  await browserView.destroy(overflowHost)
  overflowHost.destroy()
  await Promise.all(
    heldHosts.map(async (host) => {
      await browserView.destroy(host)
      host.destroy()
    }),
  )
  browserView.show(second, rect)
  const successorView = webContents.getAllWebContents().find((item) => item.id !== second.webContents.id)!
  assert.notEqual(successorView.id, retainedView.id)
  await browserView.destroy(second)
  const unknownClose = {
    timeoutRetained: true,
    replacementRefused: true,
    repeatCloseCalls: closeCalls,
    lateConfirmationReleased: successorView.isDestroyed(),
    capacityIncludesUnknown: true,
  }
  await fs.writeFile(
    path.join(process.env.DAC_BROWSER_TEST_ROOT!, "result.json"),
    JSON.stringify(
      {
        pid: process.pid,
        electron: process.versions.electron,
        initial,
        navigation,
        subframeRejected,
        afterFirstDestroy,
        afterHostClose,
        final,
        unknownClose,
      },
      null,
      2,
    ),
  )
  second.destroy()
  assert.deepEqual(initial, { firstChildren: 1, secondChildren: 1, separateContents: true })
  assert.deepEqual(afterFirstDestroy, {
    firstDestroyed: true,
    secondAlive: true,
    firstChildren: 0,
    secondChildren: 1,
    listenerReleased: true,
  })
  assert.deepEqual(afterHostClose, { replacementDestroyed: true, secondAlive: true })
  assert.deepEqual(final, { secondDestroyed: true })
  assert.equal(subframeRejected, true)
  assert.deepEqual(navigation, {
    firstURL: `${origin}/first`,
    secondURL: `${origin}/second`,
    firstHidden: true,
    secondVisible: true,
  })
  await new Promise<void>((resolve) => server.close(() => resolve()))
  app.exit(0)
}

function waitForURL(contents: WebContents, url: string) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      if (contents.getURL() !== url || contents.isLoadingMainFrame()) return
      contents.removeListener("did-stop-loading", finish)
      resolve()
    }
    contents.on("did-stop-loading", finish)
  })
}
void main().catch((error) => {
  console.error(error)
  app.exit(1)
})
