import { createConnection } from "net"
import { createServer } from "http"
import * as Log from "@deepagent-code/core/util/log"
import { OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH, parseRedirectUri } from "./oauth-provider"

const log = Log.create({ service: "mcp.oauth-callback" })

let currentPort = OAUTH_CALLBACK_PORT
let currentPath = OAUTH_CALLBACK_PATH
let operation = Promise.resolve()

const HTML_SUCCESS = `<!DOCTYPE html>
<html>
<head>
  <title>DeepAgent Code - Authorization Successful</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #4ade80; margin-bottom: 1rem; }
    p { color: #aaa; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Successful</h1>
    <p>You can close this window and return to DeepAgent Code.</p>
  </div>
  <script>setTimeout(() => window.close(), 2000);</script>
</body>
</html>`

const HTML_ERROR = (error: string) => `<!DOCTYPE html>
<html>
<head>
  <title>DeepAgent Code - Authorization Failed</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #f87171; margin-bottom: 1rem; }
    p { color: #aaa; }
    .error { color: #fca5a5; font-family: monospace; margin-top: 1rem; padding: 1rem; background: rgba(248,113,113,0.1); border-radius: 0.5rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Failed</h1>
    <p>An error occurred during authorization.</p>
    <div class="error">${escapeHtml(error)}</div>
  </div>
</body>
</html>`

interface PendingAuth {
  resolve: (code: string) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

let server: ReturnType<typeof createServer> | undefined
const pendingAuths = new Map<string, PendingAuth>()
// Reverse index: mcpName → oauthState, so cancelPending(mcpName) can
// find the right entry in pendingAuths (which is keyed by oauthState).
const mcpNameToState = new Map<string, string>()

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
const MAX_PENDING_AUTHS = 64

function cleanupStateIndex(oauthState: string) {
  for (const [name, state] of mcpNameToState) {
    if (state === oauthState) {
      mcpNameToState.delete(name)
      break
    }
  }
}

function handleRequest(
  req: import("http").IncomingMessage,
  res: import("http").ServerResponse,
  port: number,
  callbackPath: string,
) {
  const url = new URL(req.url || "/", `http://localhost:${port}`)

  if (url.pathname !== callbackPath) {
    res.writeHead(404)
    res.end("Not found")
    return
  }

  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const error = url.searchParams.get("error")
  const errorDescription = url.searchParams.get("error_description")

  log.info("received oauth callback", { hasCode: !!code, hasState: !!state, hasError: !!error })

  // Enforce state parameter presence
  if (!state) {
    const errorMsg = "Missing required state parameter - potential CSRF attack"
    log.error("oauth callback missing state parameter", { path: url.pathname })
    res.writeHead(400, { "Content-Type": "text/html" })
    res.end(HTML_ERROR(errorMsg))
    return
  }

  if (error) {
    const errorMsg = errorDescription || error
    if (pendingAuths.has(state)) {
      const pending = pendingAuths.get(state)!
      clearTimeout(pending.timeout)
      pendingAuths.delete(state)
      cleanupStateIndex(state)
      pending.reject(new Error(errorMsg))
    }
    res.writeHead(200, { "Content-Type": "text/html" })
    res.end(HTML_ERROR(errorMsg))
    return
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html" })
    res.end(HTML_ERROR("No authorization code provided"))
    return
  }

  // Validate state parameter
  if (!pendingAuths.has(state)) {
    const errorMsg = "Invalid or expired state parameter - potential CSRF attack"
    log.error("oauth callback with invalid or expired state")
    res.writeHead(400, { "Content-Type": "text/html" })
    res.end(HTML_ERROR(errorMsg))
    return
  }

  const pending = pendingAuths.get(state)!

  clearTimeout(pending.timeout)
  pendingAuths.delete(state)
  cleanupStateIndex(state)
  pending.resolve(code)

  res.writeHead(200, { "Content-Type": "text/html" })
  res.end(HTML_SUCCESS)
}

export function ensureRunning(redirectUri?: string): Promise<void> {
  return serialize(() => ensureRunningSerial(redirectUri))
}

async function ensureRunningSerial(redirectUri?: string) {
  const { port, path } = parseRedirectUri(redirectUri)

  if (server && (currentPort !== port || currentPath !== path)) {
    log.info("stopping oauth callback server to reconfigure", { oldPort: currentPort, newPort: port })
    await stopSerial()
  }

  if (server) return

  const next = createServer((request, response) => handleRequest(request, response, port, path))
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      next.removeListener("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      next.removeListener("error", onError)
      resolve()
    }
    next.once("error", onError)
    next.once("listening", onListening)
    next.listen(port, "127.0.0.1")
  })
  next.on("error", (error) => log.warn("oauth callback server error", { error }))
  currentPort = port
  currentPath = path
  server = next
  log.info("oauth callback server started", { port, path })
}

export function waitForCallback(oauthState: string, mcpName?: string): Promise<string> {
  if (pendingAuths.has(oauthState)) return Promise.reject(new Error("OAuth state is already pending"))
  if (mcpName && mcpNameToState.has(mcpName)) return Promise.reject(new Error("MCP OAuth is already pending"))
  if (pendingAuths.size >= MAX_PENDING_AUTHS) return Promise.reject(new Error("Too many pending OAuth callbacks"))
  if (mcpName) mcpNameToState.set(mcpName, oauthState)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingAuths.has(oauthState)) {
        pendingAuths.delete(oauthState)
        if (mcpName) mcpNameToState.delete(mcpName)
        reject(new Error("OAuth callback timeout - authorization took too long"))
      }
    }, CALLBACK_TIMEOUT_MS)

    pendingAuths.set(oauthState, { resolve, reject, timeout })
  })
}

export function cancelPending(mcpName: string): void {
  // Look up the oauthState for this mcpName via the reverse index
  const oauthState = mcpNameToState.get(mcpName)
  const key = oauthState ?? mcpName
  const pending = pendingAuths.get(key)
  if (pending) {
    clearTimeout(pending.timeout)
    pendingAuths.delete(key)
    mcpNameToState.delete(mcpName)
    pending.reject(new Error("Authorization cancelled"))
  }
}

export async function isPortInUse(port: number = OAUTH_CALLBACK_PORT): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(port, "127.0.0.1")
    socket.on("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.on("error", () => {
      resolve(false)
    })
  })
}

export function stop(): Promise<void> {
  return serialize(stopSerial)
}

async function stopSerial() {
  if (server) {
    const current = server
    server = undefined
    await new Promise<void>((resolve, reject) => current.close((error) => (error ? reject(error) : resolve())))
    log.info("oauth callback server stopped")
  }

  for (const [_name, pending] of pendingAuths) {
    clearTimeout(pending.timeout)
    pending.reject(new Error("OAuth callback server stopped"))
  }
  pendingAuths.clear()
  mcpNameToState.clear()
}

function serialize(task: () => Promise<void>) {
  const result = operation.then(task, task)
  operation = result.catch(() => {})
  return result
}

export function isRunning(): boolean {
  return server !== undefined
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    if (character === "&") return "&amp;"
    if (character === "<") return "&lt;"
    if (character === ">") return "&gt;"
    if (character === '"') return "&quot;"
    return "&#39;"
  })
}

export * as McpOAuthCallback from "./oauth-callback"
