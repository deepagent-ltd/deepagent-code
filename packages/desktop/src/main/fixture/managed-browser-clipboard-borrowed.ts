import { app, BrowserWindow } from "electron"
import fs from "node:fs/promises"
import path from "node:path"
import { installManagedBrowserClipboardPolicy } from "../managed-browser-clipboard-policy"

const root = process.env.DAC_BROWSER_CLIPBOARD_BORROWED_ROOT!

async function main() {
  app.setPath("userData", path.join(root, "profile"))
  app.on("window-all-closed", () => {})
  await app.whenReady()
  const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } })
  const facts: unknown[] = []
  try {
    await window.webContents.loadURL("about:blank")
    window.webContents.debugger.attach("1.3")
    await window.webContents.debugger.sendCommand("Page.enable")
    await installManagedBrowserClipboardPolicy(window.webContents)
    for (const method of ["open", "write", "writeln"]) {
      console.log("BORROWED_STAGE", method, "load")
      await window.webContents.loadURL("data:text/html," + encodeURIComponent("<h1>Owned parent</h1><textarea>普通编辑</textarea>"))
      console.log("BORROWED_STAGE", method, "execute")
      facts.push(await window.webContents.executeJavaScript(`(() => {
        const frame = document.createElement('iframe');
        document.body.append(frame);
        const prototype = frame.contentWindow.Document.prototype;
        const own = Object.getOwnPropertyDescriptor(prototype, '${method}');
        const foreign = prototype['${method}'];
        const guarded = own?.configurable === false && own?.writable === false;
        if (!guarded) return {method:'${method}',guarded,defaultDenied:[],normalEditing:false};
        // Calling a child's original wrapper on its parent removes the child document.
        // The captured function's realm and the receiver document now differ.
        if ('${method}' === 'open') foreign.call(document);
        else foreign.call(document, '<h1>Replacement parent</h1><textarea>普通编辑</textarea>');
        document.close();
        const defaultDenied = ['copy','cut','paste'].map(type => {
          let reached = false;
          window.addEventListener(type, () => {reached=true},true);
          const event = new ClipboardEvent(type,{bubbles:true,cancelable:true});
          const result = document.dispatchEvent(event);
          return {type,denied:result===false && event.defaultPrevented && !reached};
        });
        return {method:'${method}',guarded,defaultDenied,normalEditing:document.execCommand('selectAll')===true};
      })()`))
      console.log("BORROWED_STAGE", method, "settled")
    }
  } finally { window.destroy() }
  await fs.writeFile(path.join(root, "result.json"), JSON.stringify({ facts, windows: BrowserWindow.getAllWindows().length,
    clipboardNativeCalls: 0, syntheticEventsOnly: true, electron: process.versions.electron, node: process.versions.node }), { mode: 0o600 })
}

void main().then(() => app.exit(0), async (error: unknown) => {
  await fs.writeFile(path.join(root, "failure.json"), JSON.stringify({ name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : "Fixture failed" }), { mode: 0o600 })
  app.exit(1)
})
