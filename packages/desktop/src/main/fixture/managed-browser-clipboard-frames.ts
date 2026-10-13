import { app, BrowserWindow, session } from "electron"
import { createServer } from "node:http"
import { writeFile } from "node:fs/promises"
import { appendFileSync } from "node:fs"
import path from "node:path"
import { installManagedBrowserClipboardPolicy } from "../managed-browser-clipboard-policy"

const root = process.argv[2]!
const mark = (value: unknown) => appendFileSync(path.join(root, "stages.log"), JSON.stringify(value) + "\n")
process.on("uncaughtException", (error) => { mark({fatal:error.name,message:error.message.slice(0,120)}); app.exit(1) })
process.on("unhandledRejection", (error: unknown) => { mark({rejection:error instanceof Error ? error.message.slice(0,120) : "unknown"}); app.exit(1) })
app.setPath("userData", path.join(root, "profile"))
app.commandLine.appendSwitch("site-per-process")
app.on("window-all-closed", () => {})

async function main() {
  await app.whenReady()
  const partition = session.fromPartition(`qa-clipboard-frames-${crypto.randomUUID()}`)
  partition.setPermissionCheckHandler(() => false)
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  const peer = createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8")
    if (request.url === "/frame") {
      response.end(`<textarea>原文</textarea><script>
        const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'execCommand');
        const guarded = descriptor?.configurable === false && descriptor?.writable === false &&
          typeof Document.prototype[Symbol.for('dac-managed-clipboard-policy-v1')] === 'function';
        const event = new ClipboardEvent('copy', {bubbles:true,cancelable:true});
        const defaultDenied = !document.dispatchEvent(event) && event.defaultPrevented;
        // Inspect policy and dispatch a synthetic event only; never use an OS clipboard command.
        const node = document.querySelector('textarea'); node.focus(); node.setSelectionRange(2,2);
        const inserted = document.execCommand('insertText',false,'中文') && node.value === '原文中文';
        const undone = document.execCommand('undo') && node.value === '原文';
        parent.postMessage({guarded,defaultDenied,inserted,undone,focused:document.activeElement===node}, '*');
      </script>`)
      return
    }
    if (request.url === "/") {
      response.end(`<title>First party frame compatibility</title>
        <script>window.frameResult = null; window.addEventListener('message',event=>{
          const child = document.querySelector('iframe');
          if(child && event.source===child.contentWindow && event.origin==='http://localhost:${(peer.address() as { port: number }).port}') window.frameResult=event.data;
        });</script><iframe src="http://localhost:${(peer.address() as { port: number }).port}/frame"></iframe>`)
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve))
  const window = new BrowserWindow({ show: false, webPreferences: {
    session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false,
  } })
  try {
    await window.webContents.loadURL("about:blank")
    mark("initial-document")
    window.webContents.debugger.attach("1.3")
    const send = window.webContents.debugger.sendCommand.bind(window.webContents.debugger)
    window.webContents.debugger.sendCommand = async (method, parameters, child) => {
      mark({command:method,child:Boolean(child),phase:"begin"})
      const result = await send(method, parameters, child)
      mark({command:method,child:Boolean(child),phase:"end"})
      return result
    }
    window.webContents.debugger.on("message", (_event, method, params, parent) => {
      if (method.startsWith("Target.")) mark({method,type:params.targetInfo?.type,
        parentLength:parent?.length,childLength:params.sessionId?.length,paused:params.waitingForDebugger})
    })
    await window.webContents.debugger.sendCommand("Page.enable")
    mark("page-enabled")
    await installManagedBrowserClipboardPolicy(window.webContents)
    mark("policy-installed")
    await window.webContents.loadURL(`http://127.0.0.1:${(peer.address() as { port: number }).port}/`)
    mark("page-loaded")
    const frame = await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
      const deadline=Date.now()+3000;
      const wait=()=>{if(window.frameResult){resolve(window.frameResult);return;}
        if(Date.now()>deadline){reject(new Error('QA_FRAME_RESULT_TIMEOUT'));return;}setTimeout(wait,10);};wait();
    })`, true)
    const child = window.webContents.mainFrame.frames.find((frame) => frame.url.startsWith("http://localhost:"))
    await writeFile(path.join(root, "result.json"), JSON.stringify({ frame,
      crossOrigin: Boolean(child), outOfProcess: Boolean(child && child.processId !== window.webContents.mainFrame.processId),
      nativeClipboardCalls: 0, externalRequests: 0, provider: 0,
      runtime: { electron: process.versions.electron, arch: process.arch } }))
  } finally {
    mark("closing-window")
    if (!window.isDestroyed()) window.destroy()
    mark("window-destroyed")
    peer.closeAllConnections()
    mark("peer-connections-closed")
    await new Promise<void>((resolve) => peer.close(() => resolve()))
    mark("peer-closed")
  }
}

main().then(() => { mark("done"); app.exit(0) }, (error: unknown) => { mark({failure:error instanceof Error ? error.message.slice(0,120) : "unknown"}); app.exit(1) })
