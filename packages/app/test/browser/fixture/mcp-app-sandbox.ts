import { createMcpAppBridge, mcpAppPermissions, mcpAppSandboxUrl } from "../../../src/utils/mcp-app-sandbox"

const fixture = globalThis as unknown as { appTest: { ready: number; rejectedSources: number; received: unknown[]; sent: unknown[]; close: () => void } }
const html = await fetch("/app").then((response) => response.text())
const frame = document.createElement("iframe")
frame.sandbox.add("allow-scripts")
frame.allow = mcpAppPermissions
frame.referrerPolicy = "no-referrer"
frame.style.cssText = "width:400px;height:320px"
const observations = { ready: 0, rejectedSources: 0, received: [] as unknown[], sent: [] as unknown[], close: () => {} }
const bridge = createMcpAppBridge({
  html,
  post: (message) => {
    observations.sent.push(message)
    frame.contentWindow?.postMessage(message, "*")
  },
  onReady: () => observations.ready++,
})
observations.close = () => bridge.close()
fixture.appTest = observations
addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow || event.origin !== "null") {
    observations.rejectedSources++
    return
  }
  observations.received.push(event.data)
  bridge.receive(event.data)
})
frame.src = mcpAppSandboxUrl(location.origin)
document.body.append(frame)
