import { app, utilityProcess } from "electron"
import { createServer } from "node:http"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { installManagedBrowser } from "../managed-browser"

app.setPath("userData", path.join(process.env.DAC_BROWSER_TEST_ROOT!, "electron-user"))
app.setPath("sessionData", path.join(process.env.DAC_BROWSER_TEST_ROOT!, "electron-session"))
app.commandLine.appendSwitch("disable-background-networking")
app.on("window-all-closed", () => {})
async function main() {
await app.whenReady()
const requests: string[] = []
let deniedTCP = 0
const denied = createServer((_req, res) => { res.end("forbidden sink") })
denied.on("connection", () => deniedTCP++)
await new Promise<void>((resolve) => denied.listen(0, "127.0.0.1", resolve))
const deniedAddress = denied.address()
if (!deniedAddress || typeof deniedAddress === "string") throw new Error("No denied port")
const deniedURL = `http://127.0.0.1:${deniedAddress.port}/outside`
// The managed profile must ignore inherited proxy configuration, including when
// the environment explicitly removes the normal loopback bypass.
const inheritedProxy = `http://127.0.0.1:${deniedAddress.port}`
Object.assign(process.env, { HTTP_PROXY: inheritedProxy, HTTPS_PROXY: inheritedProxy, ALL_PROXY: inheritedProxy,
  http_proxy: inheritedProxy, https_proxy: inheritedProxy, all_proxy: inheritedProxy, NO_PROXY: "", no_proxy: "" })
const allowed = createServer((req, res) => {
  requests.push(req.url ?? "")
  if (process.env.DAC_BROWSER_CAPACITY === "1" && req.url === "/slow") {
    if (requests.filter((value) => value === "/slow").length === 2) child.postMessage({ type: "slow-ready" })
    return
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8")
  res.end(`<html><body style="background:#173840;color:white"><h1>原生浏览器 fixture</h1><p>Snapshot text from actual Chromium</p><img src="${deniedURL}"><script>fetch(${JSON.stringify(deniedURL)}).catch(()=>{});window.open(${JSON.stringify(deniedURL)});new WebSocket(${JSON.stringify(deniedURL.replace('http:','ws:'))});</script></body></html>`)
})
await new Promise<void>((resolve) => allowed.listen(0, "127.0.0.1", resolve))
const address = allowed.address()
if (!address || typeof address === "string") throw new Error("No allowed port")
const child = utilityProcess.fork(process.env.DAC_BROWSER_CHILD!, [], { env: {
  ...process.env, DAC_BROWSER_ORIGIN: `http://127.0.0.1:${address.port}`, DAC_BROWSER_DENIED: deniedURL,
}, stdio: "pipe" })
child.stdout?.on("data", (data) => process.stdout.write(data))
child.stderr?.on("data", (data) => process.stderr.write(data))
const timer = setTimeout(() => { child.kill(); app.exit(2) }, 45_000)
child.on("message", (message) => {
  if (message.type === "managed-browser-bootstrap-ready-v1") { installManagedBrowser(child, "fixture-password"); return }
  if (message.type !== "result" && message.type !== "fixture-error") return
  void writeFile(path.join(process.env.DAC_BROWSER_TEST_ROOT!, "result.json"), JSON.stringify({ message, requests, deniedTCP, inheritedProxyConfigured: true }, null, 2)).then(() => {
    clearTimeout(timer)
    child.kill()
    allowed.closeAllConnections(); denied.closeAllConnections()
    allowed.close(); denied.close()
    app.exit(message.type === "result" ? 0 : 1)
  })
})

}
void main().catch(async (error) => {
  await writeFile(path.join(process.env.DAC_BROWSER_TEST_ROOT!, "result.json"), JSON.stringify({ error: String(error), stack: error.stack }))
  app.exit(1)
})
