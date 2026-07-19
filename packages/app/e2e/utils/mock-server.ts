import type { Page, Route } from "@playwright/test"

const emptyList = new Set([
  "/skill",
  "/command",
  "/lsp",
  "/formatter",
  "/permission",
  "/question",
  "/vcs/status",
  "/vcs/diff",
])
const emptyObject = new Set(["/global/config", "/config", "/provider/auth", "/mcp", "/session/status"])

export interface MockServerConfig {
  provider: unknown
  directory: string
  project: unknown
  sessions: ({ id: string } & Record<string, unknown>)[]
  pageMessages: (sessionId: string, limit: number, before?: string) => { items: unknown[]; cursor?: string }
  events?: () => unknown[]
}

export async function mockDeepAgentCodeServer(page: Page, config: MockServerConfig) {
  let ptySequence = 0
  const ptys = new Map<string, { id: string; title: string }>()
  const staticRoutes: Record<string, unknown> = {
    "/provider": config.provider,
    "/path": {
      state: config.directory,
      config: config.directory,
      worktree: config.directory,
      directory: config.directory,
      home: "C:/DeepAgent Code",
    },
    "/project": [config.project],
    "/project/current": config.project,
    "/agent": [{ name: "build", mode: "primary" }],
    "/vcs": { branch: "main", default_branch: "main" },
    "/session": config.sessions,
  }

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    const targetPort = process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"
    if (url.port !== targetPort) return route.fallback()

    const path = url.pathname
    if (path === "/global/event" || path === "/event") return sse(route, config.events?.())
    if (path === "/global/health") return json(route, { healthy: true, version: "test", runtimeId: "runtime-test" })
    if (path === "/pty" && route.request().method() === "GET") return json(route, [...ptys.values()])
    if (path === "/pty" && route.request().method() === "POST") {
      ptySequence += 1
      const body: unknown = route.request().postDataJSON()
      const title =
        body && typeof body === "object" && "title" in body && typeof body.title === "string"
          ? body.title
          : `Terminal ${ptySequence}`
      const pty = { id: `pty_test_${ptySequence}`, title }
      ptys.set(pty.id, pty)
      return json(route, pty)
    }
    const ptyMatch = path.match(/^\/pty\/([^/]+)$/)
    if (ptyMatch && route.request().method() === "GET") {
      const pty = ptys.get(ptyMatch[1])
      return pty ? json(route, pty) : json(route, { message: "PTY session not found" }, undefined, 404)
    }
    if (ptyMatch && route.request().method() === "PUT") return json(route, ptys.get(ptyMatch[1]) ?? {})
    if (ptyMatch && route.request().method() === "DELETE") {
      ptys.delete(ptyMatch[1])
      return json(route, true)
    }
    if (/^\/pty\/[^/]+\/connect-token$/.test(path)) return json(route, { ticket: "test-ticket" })
    if (emptyObject.has(path)) return json(route, {})
    if (emptyList.has(path)) return json(route, [])
    if (path in staticRoutes) return json(route, staticRoutes[path])

    const sessionMatch = path.match(/^\/session\/([^/]+)$/)
    if (sessionMatch) {
      const session = config.sessions.find((s) => s.id === sessionMatch[1])
      return json(route, session ?? {})
    }

    if (/^\/session\/[^/]+\/(children|todo|diff)$/.test(path)) return json(route, [])

    const messagesMatch = path.match(/^\/session\/([^/]+)\/message$/)
    if (messagesMatch) {
      const limit = Number(url.searchParams.get("limit") ?? 80)
      const before = url.searchParams.get("before") ?? undefined
      const pageData = config.pageMessages(messagesMatch[1], limit, before)
      return json(route, pageData.items, pageData.cursor ? { "x-next-cursor": pageData.cursor } : undefined)
    }

    return json(route, {})
  })
}

function json(route: Route, body: unknown, headers?: Record<string, string>, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "x-next-cursor",
      ...headers,
    },
    body: JSON.stringify(body ?? null),
  })
}

function sse(route: Route, events?: unknown[]) {
  return route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: events?.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") || ": ok\n\n",
  })
}
