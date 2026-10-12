import { app, BrowserWindow, session } from "electron"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { installManagedBrowserClipboardPolicy } from "../managed-browser-clipboard-policy"

const root = process.argv[2]!
app.setPath("userData", path.join(root, "profile"))
app.on("window-all-closed", () => {})

async function main() {
  await app.whenReady()
  const partition = session.fromPartition(`qa-clipboard-policy-${crypto.randomUUID()}`)
  partition.setPermissionCheckHandler(() => false)
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  const window = new BrowserWindow({ show: false, webPreferences: {
    session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false,
  } })
  try {
    await window.webContents.loadURL("about:blank")
    window.webContents.debugger.attach("1.3")
    await window.webContents.debugger.sendCommand("Page.enable")
    console.log("QA_POLICY_STAGE install-start")
    await installManagedBrowserClipboardPolicy(window.webContents)
    console.log("QA_POLICY_STAGE install-complete")
    const rounds = []
    for (const iteration of [1, 2]) {
      await window.webContents.loadURL("data:text/html," + encodeURIComponent('<h1>Protected document</h1><textarea>synthetic</textarea>'))
      rounds.push(await window.webContents.executeJavaScript(`(async () => {
        console.log('QA_POLICY_STAGE start-${iteration}');
        const commands = (view) => {
          const descriptor = Object.getOwnPropertyDescriptor(view.Document.prototype, 'execCommand');
          const guarded = descriptor?.writable === false && descriptor?.configurable === false &&
            typeof view.Document.prototype[Symbol.for('dac-managed-clipboard-policy-v1')] === 'function';
          // Never invoke a clipboard command in a realm whose guard was not installed.
          if (!guarded) return {guarded, results: []};
          return {guarded, results: ['copy', 'CuT', ' paste '].map(value => view.document.execCommand(value))};
        };
        const normal = commands(window);
        const immutable = !Reflect.defineProperty(Document.prototype, 'execCommand', {value: () => true}) &&
          !Reflect.deleteProperty(Document.prototype, 'execCommand');
        let conversions = 0;
        const singleConversion = document.execCommand({toString(){conversions++; return conversions === 1 ? 'copy' : 'insertText'}}) === false && conversions === 1;
        const empty = document.createElement('iframe'); document.body.append(empty);
        const initialFrame = commands(empty.contentWindow);
        console.log('QA_POLICY_STAGE initial-frame');
        empty.remove();
        const child = document.createElement('iframe');
        const loaded = new Promise((resolve, reject) => { child.onload = resolve; setTimeout(() => reject(new Error('QA_SRCDOC_LOAD_TIMEOUT')),1000); });
        child.srcdoc = '<p>Protected frame</p>'; document.body.append(child); await loaded;
        console.log('QA_POLICY_STAGE srcdoc-frame');
        const srcdocFrame = commands(child.contentWindow);
        child.remove();
        console.log('QA_POLICY_STAGE before-document-replacement');
        document.open(); document.write('<h1>Replacement</h1><textarea>synthetic</textarea>'); document.close();
        console.log('QA_POLICY_STAGE after-document-replacement');
        const replacement = commands(window);
        let reached = false; window.addEventListener('copy', () => {reached = true}, true);
        const copyEvent = new ClipboardEvent('copy', {bubbles:true,cancelable:true});
        const defaultDenied = !document.dispatchEvent(copyEvent) && copyEvent.defaultPrevented && !reached;
        const normalEditing = document.execCommand('selectAll') === true;
        return {iteration:${iteration},normal,immutable,singleConversion,initialFrame,srcdocFrame,replacement,defaultDenied,normalEditing};
      })()`, true))
    }
    await writeFile(path.join(root, "result.json"), JSON.stringify({ rounds, clipboardNativeCalls: 0, provider: 0,
      runtime: {electron: process.versions.electron, node: process.versions.node, arch: process.arch} }))
  } finally {
    window.destroy()
  }
}
main().then(() => app.exit(0), (error: unknown) => { console.error(error); app.exit(1) })
