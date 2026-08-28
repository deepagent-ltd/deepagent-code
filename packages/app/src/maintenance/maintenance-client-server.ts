import type { ServerConnection } from "@/context/server"
import { type MaintenanceClient, createMaintenanceClient } from "./maintenance-client"

// Build a maintenance client against the SAME base URL + auth the SDK uses, so the
// shell consumes the live C6-01 API without a generated SDK group (C6-04 / LIC2).
// It reuses the SDK's auth derivation (bearer JWT for Server Edition, Basic for
// local/self-hosted) so the shell talks to the same authority the rest of the app does.

export function createMaintenanceClientForServer(http: ServerConnection.HttpBase): MaintenanceClient {
  const headers: Record<string, string> = {}
  if (http.bearer) headers.Authorization = `Bearer ${http.bearer}`
  else if (http.password) {
    headers.Authorization = `Basic ${btoa(`${http.username ?? "deepagent-code"}:${http.password}`)}`
  }
  return createMaintenanceClient({ baseUrl: http.url, headers })
}
