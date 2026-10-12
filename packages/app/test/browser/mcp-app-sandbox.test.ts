import { McpAppSandbox } from "@deepagent-code/core/mcp/app-sandbox"
import { expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import { createServer } from "node:http"
import { chromium } from "@playwright/test"

test.skipIf(!process.env.DAC_CHROMIUM_EXECUTABLE)("real browser isolates MCP HTML, rejects navigation/network and revokes the actual bridge", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dac-mcp-app-browser-"))
  const requests: string[] = []
  const bundled = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/mcp-app-sandbox.ts")], target: "browser", write: false })
  expect(bundled.success).toBe(true)
  const script = await bundled.outputs[0].text()
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin)
    requests.push(url.pathname)
    if (url.pathname === McpAppSandbox.path) {
      response.writeHead(200, { "content-type": "text/html", "content-security-policy": McpAppSandbox.csp }).end(McpAppSandbox.html())
      return
    }
    if (url.pathname === "/host.js") {
      response.writeHead(200, { "content-type": "text/javascript" }).end(script)
      return
    }
    if (url.pathname !== "/" && url.pathname !== "/app") {
      response.writeHead(404).end("blocked attempt")
      return
    }
    const app = `<h1>Current MCP App</h1><button id="navigate">Navigate</button><script>
      const send = (method, id, params) => parent.postMessage({jsonrpc:"2.0",method,...(id===undefined?{}:{id}),...(params?{params}:{})},"*");
      addEventListener("message", event => {
        if(event.source!==parent || event.data?.id!==1 || !event.data.result) return;
        send("ui/notifications/initialized");
        send("ping",2);
        send("tools/call",3,{name:"write",arguments:{path:"secret"}});
        parent.parent.postMessage({jsonrpc:"2.0",method:"tools/call",id:"direct",params:{name:"write"}},"*");
        let parentAccess=false;
        try { parentAccess=Boolean(parent.document); } catch {}
        let hostAccess=false;
        try { hostAccess=Boolean(top.document); } catch {}
        send("ui/notifications/test-result",undefined,{parentAccess,hostAccess,hostApi:typeof window.api,popup:window.open("${url.origin}/attempt-popup")===null});
      });
      document.getElementById("navigate").onclick=()=>{
        fetch("${url.origin}/attempt-fetch").catch(()=>{});
        const image=new Image();image.src="${url.origin}/attempt-image";document.body.append(image);
        const nested=document.createElement("iframe");nested.src="${url.origin}/attempt-frame";document.body.append(nested);
        const form=document.createElement("form");form.action="${url.origin}/attempt-form";document.body.append(form);form.submit();
        try { top.location="${url.origin}/attempt-top"; } catch {}
        location.href="${url.origin}/attempt-self";
        send("ui/notifications/test-attempted");
      };
      send("ui/initialize",1,{protocolVersion:"2026-01-26",appCapabilities:{}});
    </script>`
    if (url.pathname === "/app") {
      response.writeHead(200, { "content-type": "text/plain" }).end(app)
      return
    }
    response.writeHead(200, {
      "content-type": "text/html",
      "content-security-policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src * data:; frame-src 'self' http: https:; object-src 'none'; base-uri 'self'",
    }).end(`<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="/host.js"></script></body></html>`)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Browser fixture did not bind its own port")
  const origin = `http://127.0.0.1:${address.port}/`
  const browser = await chromium.launch({ headless: true, executablePath: process.env.DAC_CHROMIUM_EXECUTABLE, env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root } })
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(5000)
    const diagnostics: string[] = []
    page.on("console", (message) => diagnostics.push(message.text().slice(0, 1000)))
    page.on("pageerror", (error) => diagnostics.push(error.message))
    const outbound: string[] = []
    const finished: string[] = []
    const failed: { path: string; error: string | undefined }[] = []
    page.on("request", (request) => outbound.push(new URL(request.url()).pathname))
    page.on("requestfinished", (request) => finished.push(new URL(request.url()).pathname))
    page.on("requestfailed", (request) => failed.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }))
    await page.goto(origin, { timeout: 5000 })
    await page.waitForFunction(() => (globalThis as unknown as { appTest: { ready: number; received: unknown[] } }).appTest?.received.some((message) => (message as { method?: string }).method === "ui/notifications/test-result"), undefined, { timeout: 5000 }).catch(async (error: unknown) => {
      console.info("MCP_APP_BROWSER_DIAGNOSTIC", JSON.stringify({ diagnostics, frames: page.frames().map((frame) => frame.url().startsWith("data:") ? "data:trusted-proxy" : frame.url()), messages: await page.evaluate(() => {
        const state = (globalThis as unknown as { appTest?: { ready: number; received: { method?: string }[]; sent: { method?: string }[] } }).appTest
        return state && { ready: state.ready, received: state.received.map((message) => message.method), sent: state.sent.map((message) => message.method) }
      }) }))
      throw error
    })
    const result = await page.evaluate(() => (globalThis as unknown as { appTest: { received: unknown[]; sent: unknown[]; rejectedSources: number } }).appTest)
    expect(result.sent).toContainEqual({ jsonrpc: "2.0", id: 2, result: {} })
    expect(result.sent).toContainEqual({ jsonrpc: "2.0", id: 3, error: { code: -32601, message: "UNSUPPORTED_CAPABILITY: this view cannot execute tools, read other resources, navigate, or access host services" } })
    expect(result.received).toContainEqual({ jsonrpc: "2.0", method: "ui/notifications/test-result", params: { parentAccess: false, hostAccess: false, hostApi: "undefined", popup: true } })
    expect(result.rejectedSources).toBe(1)
    expect(result.sent.some((message) => (message as Record<string, unknown>).id === "direct")).toBe(false)
    console.info("MCP_APP_BROWSER_FRAMES", JSON.stringify(page.frames().map((frame) => ({ name: frame.name(), url: frame.url().slice(0, 60) }))))
    const views = await Promise.all(page.frames().map(async (frame) => ({ frame, count: await frame.getByRole("heading", { name: "Current MCP App", exact: true }).count() })))
    const view = views.find((item) => item.count === 1)?.frame
    expect(view).toBeDefined()
    const rejectedImage = page.waitForEvent("requestfailed", { predicate: (request) => new URL(request.url()).pathname === "/attempt-image", timeout: 5000 })
    await view!.getByRole("button", { name: "Navigate", exact: true }).click()
    await page.waitForFunction(() => (globalThis as unknown as { appTest: { received: { method: string }[] } }).appTest.received.some((message) => message.method === "ui/notifications/test-attempted"), undefined, { timeout: 5000 })
    await rejectedImage
    expect(page.url()).toBe(origin)
    expect(finished.filter((request) => request.startsWith("/attempt-"))).toEqual([])
    for (const request of outbound.filter((request) => request.startsWith("/attempt-"))) expect(failed.some((failure) => failure.path === request && ["csp", "net::ERR_BLOCKED_BY_CSP"].includes(failure.error ?? ""))).toBe(true)
    expect(requests.filter((request) => request.startsWith("/attempt-"))).toEqual([])
    const detached = page.frames().includes(view!) ? page.waitForEvent("framedetached", { predicate: (frame) => frame === view, timeout: 5000 }) : Promise.resolve()
    await page.evaluate(() => (globalThis as unknown as { appTest: { close: () => void } }).appTest.close())
    await detached
    expect(page.frame({ name: "dac-mcp-app-view" })).toBeNull()
    const count = await page.evaluate(() => (globalThis as unknown as { appTest: { sent: unknown[] } }).appTest.sent.length)
    await page.evaluate(() => window.postMessage({ jsonrpc: "2.0", method: "tools/call", id: "late" }, "*"))
    expect(await page.evaluate(() => (globalThis as unknown as { appTest: { sent: unknown[] } }).appTest.sent.length)).toBe(count)
  } finally {
    await browser.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
