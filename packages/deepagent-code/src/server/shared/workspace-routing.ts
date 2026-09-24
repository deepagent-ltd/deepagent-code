import { SessionID } from "@/session/schema"

type Rule = { method?: string; path: string; exact?: boolean; action: "local" | "forward" }

const RULES: Array<Rule> = [
  { path: "/experimental/workspace", action: "local" },
  { method: "POST", path: "/sync/replay", exact: true, action: "local" },
  { method: "POST", path: "/sync/steal", exact: true, action: "local" },
  { path: "/session/status", action: "forward" },
  { method: "GET", path: "/session", action: "local" },
  // PTY sessions are owned by the control-plane process. Proxying /pty WebSocket
  // upgrades to a workspace server drops the connection — the workspace has no PTY
  // handler — which surfaces as "Terminal creation timed out" with no server-side
  // error beyond a silent proxy failure.
  { path: "/pty", action: "local" },
]

export function isLocalWorkspaceRoute(method: string, path: string) {
  for (const rule of RULES) {
    if (rule.method && rule.method !== method) continue
    const match = rule.exact ? path === rule.path : path === rule.path || path.startsWith(rule.path + "/")
    if (match) return rule.action === "local"
  }
  return false
}

export function getWorkspaceRouteSessionID(url: URL) {
  if ([
    "/session/status",
    "/session/import-snapshot",
    "/session/import-bundle",
    "/session/import-bundle-share",
    "/session/revoke-bundle-share",
  ].includes(url.pathname)) return null

  const id =
    url.pathname.match(/^\/session\/([^/]+)(?:\/|$)/)?.[1] ??
    url.pathname.match(/^\/experimental\/session\/([^/]+)\/background$/)?.[1]
  if (!id) return null

  return SessionID.make(id)
}

export function workspaceProxyURL(target: string | URL, requestURL: URL) {
  const proxyURL = new URL(target)
  proxyURL.pathname = `${proxyURL.pathname.replace(/\/$/, "")}${requestURL.pathname}`
  proxyURL.search = requestURL.search
  proxyURL.hash = requestURL.hash
  proxyURL.searchParams.delete("workspace")
  return proxyURL
}
