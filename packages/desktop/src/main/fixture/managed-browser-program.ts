import { app, utilityProcess } from "electron"
import { createServer } from "node:http"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { installManagedBrowser } from "../managed-browser"

app.setPath("userData", path.join(process.env.DAC_BROWSER_TEST_ROOT!, "electron-user"))
app.setPath("sessionData", path.join(process.env.DAC_BROWSER_TEST_ROOT!, "electron-session"))
app.commandLine.appendSwitch("disable-background-networking")
// Keep ambient WindowServer pointer events outside this private qualifier while
// preserving a shown Chromium window for the original CDP/native input path.
app.on("browser-window-created", (_event, window) => {
  window.on("show", () => window.setPosition(-10_000, -10_000))
  window.setPosition(-10_000, -10_000)
})
app.on("window-all-closed", () => {})

async function main() {
  await app.whenReady()
  const requests: Array<{ method: string; url: string; body: string }> = []
  let deniedTCP = 0
  const denied = createServer((_req, res) => res.end("forbidden"))
  denied.on("connection", () => deniedTCP++)
  await new Promise<void>((resolve) => denied.listen(0, "127.0.0.1", resolve))
  const deniedAddress = denied.address()
  if (!deniedAddress || typeof deniedAddress === "string") throw new Error("Missing sink port")
  const deniedURL = `http://127.0.0.1:${deniedAddress.port}/outside`
  let lateRequestsCompleted = 0
  app.on("web-contents-created", (_event, contents) => {
    contents.on("console-message", (details) => {
      if (details.message !== "PROGRAM_LATE_REQUESTS_COMPLETED") return
      lateRequestsCompleted++
      child.postMessage({ type: "late-complete" })
    })
  })
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    requests.push({ method: req.method ?? "", url: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") })
    res.setHeader("Content-Type", "text/html; charset=utf-8")
    if (req.url === "/program-hold-submit") {
      child.postMessage({ type: "hold-ready" })
      return
    }
    if (req.url === "/program-submit") {
      res.end("<html><body><h1>Program submitted</h1></body></html>")
      return
    }
    const stale = req.url === "/program-stale"
    const hold = req.url === "/program-hold"
    res.end(`<html><body ${req.url === "/program-preflight-target" ? "data-select-tail" : ""}><h1>Program fixture</h1><form method="post" action="${hold ? "/program-hold-submit" : "/program-submit"}">
      <label>Name<input name="name" aria-label="Name" ${stale ? "oninput=\"document.querySelector('select').disabled=true\"" : ""}></label>
      <label>Choice<select name="choice" aria-label="Choice"><option value="a">A</option><option value="b">B</option></select></label>
      <button type="submit">Submit</button></form><label>Tail<input aria-label="Tail" value="untouched"></label>
      <script>document.querySelector('input').addEventListener('input',()=>fetch('/program-nonterminal').catch(()=>{}));
      ${
        hold
          ? `document.querySelector('input').addEventListener('input',()=>{ if(window.programLateScheduled)return;window.programLateScheduled=true;
      const attempt=()=>{if(!window.programFinalClicked){setTimeout(attempt,20);return}
      Promise.allSettled([fetch('/program-late-get'),fetch('/program-late-post',{method:'POST',headers:{'content-type':'text/plain'},body:'late'}),fetch(${JSON.stringify(deniedURL)})]).then(()=>console.log('PROGRAM_LATE_REQUESTS_COMPLETED'))};setTimeout(attempt,100)});
      document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();window.programFinalClicked=true;setTimeout(()=>event.target.submit(),1000)});`
          : ""
      }</script>
      </body></html>`)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing origin port")
  const child = utilityProcess.fork(process.env.DAC_BROWSER_CHILD!, [], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.DAC_BROWSER_TEST_ROOT!,
      TMPDIR: process.env.DAC_BROWSER_TEST_ROOT!,
      XDG_CONFIG_HOME: process.env.DAC_BROWSER_TEST_ROOT!,
      XDG_DATA_HOME: process.env.DAC_BROWSER_TEST_ROOT!,
      XDG_CACHE_HOME: process.env.DAC_BROWSER_TEST_ROOT!,
      DAC_BROWSER_ORIGIN: `http://127.0.0.1:${address.port}`,
      DAC_BROWSER_DENIED: deniedURL,
    },
    stdio: "pipe",
  })
  child.stdout?.on("data", (data) => process.stdout.write(data))
  child.stderr?.on("data", (data) => process.stderr.write(data))
  const timer = setTimeout(() => {
    child.kill()
    app.exit(2)
  }, 45_000)
  child.on("message", (message) => {
    if (message.type === "managed-browser-bootstrap-ready-v1") {
      installManagedBrowser(child, "program-fixture")
      return
    }
    if (message.type !== "result" && message.type !== "fixture-error") return
    void writeFile(
      path.join(process.env.DAC_BROWSER_TEST_ROOT!, "result.json"),
      JSON.stringify({ message, requests, deniedTCP, lateRequestsCompleted }, null, 2),
    ).then(() => {
      clearTimeout(timer)
      child.kill()
      server.closeAllConnections()
      denied.closeAllConnections()
      server.close()
      denied.close()
      app.exit(message.type === "result" ? 0 : 1)
    })
  })
}

void main().catch(async (error) => {
  await writeFile(
    path.join(process.env.DAC_BROWSER_TEST_ROOT!, "result.json"),
    JSON.stringify({ error: String(error), stack: error instanceof Error ? error.stack : undefined }),
  )
  app.exit(1)
})
