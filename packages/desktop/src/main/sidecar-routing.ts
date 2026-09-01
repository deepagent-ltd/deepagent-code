import type { WslServerItem } from "../preload/types"

// Error code attached to any failure to bring the local sidecar up (fork error,
// ready-message timeout, early exit, sidecar-reported start error). The win32
// routing in index.ts uses it to decide whether an automatic WSL fallback applies.
export const SIDECAR_SPAWN_FAILED = "SIDECAR_SPAWN_FAILED"

export const WSL_SIDECAR_MODE_ENV = "DEEPAGENT_CODE_DESKTOP_WSL_SIDECAR"

// force = always spawn the sidecar through WSL; auto = native local spawn with
// automatic WSL fallback on failure; native = local only, never fall back.
export type WslSidecarMode = "force" | "auto" | "native"

export function resolveWslSidecarMode(env: Record<string, string | undefined> = process.env): WslSidecarMode {
  const value = env[WSL_SIDECAR_MODE_ENV]
  if (value === "force" || value === "native") return value
  return "auto"
}

export function sidecarSpawnFailure(message: string, cause?: unknown): Error {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause })
  return Object.assign(error, { code: SIDECAR_SPAWN_FAILED })
}

export function isSidecarSpawnFailure(error: unknown): boolean {
  return error instanceof Error && (error as Error & { code?: unknown }).code === SIDECAR_SPAWN_FAILED
}

export type WslServerReady = {
  id: string
  url: string
  username: string | null
  password: string | null
}

export function firstReadyWslServer(servers: readonly WslServerItem[]): WslServerReady | null {
  for (const item of servers) {
    if (item.runtime.kind !== "ready") continue
    return {
      id: item.config.id,
      url: item.runtime.url,
      username: item.runtime.username,
      password: item.runtime.password,
    }
  }
  return null
}
