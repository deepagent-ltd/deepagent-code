import type { ServerReadyData, WslServerItem, WslServersState } from "../preload/types"
import type { WslServersController } from "./wsl/servers"

// Error code attached to any failure to bring the primary sidecar up (fork
// error, ready-message timeout, early exit, sidecar-reported start error, or a
// failed API-ready health check). The win32 routing in startPrimarySidecar
// uses it to decide whether an automatic WSL fallback applies.
export const SIDECAR_SPAWN_FAILED = "SIDECAR_SPAWN_FAILED"

export const WSL_SIDECAR_MODE_ENV = "DEEPAGENT_CODE_DESKTOP_WSL_SIDECAR"

// force = always spawn the sidecar through WSL; auto = native local spawn with
// automatic WSL fallback on failure; native = local only, never fall back.
export type WslSidecarMode = "force" | "auto" | "native"

// Budget for the local sidecar's API-ready health wait. The `ready` IPC message
// only proves the listener socket is open, so startPrimarySidecar waits for the
// health endpoint to answer inside the fallback decision domain. This replaces
// the old caller-side Effect.timeout("15 seconds"), which ran after the routing
// settled and let a dead URL through to the renderer.
export const LOCAL_HEALTH_TIMEOUT_MS = 15_000

// Budget for a WSL fallback: WSL2 distro boot plus a fresh `deepagent-code serve`
// start. Each spawnWslSidecar already polls its own health (30s default) inside
// that budget, so a ready WSL server typically resolves far sooner.
export const WSL_FALLBACK_TIMEOUT_MS = 120_000

export function resolveWslSidecarMode(env: Record<string, string | undefined> = process.env): WslSidecarMode {
  const value = env[WSL_SIDECAR_MODE_ENV]
  if (value === "force" || value === "native") return value
  return "auto"
}

export function sidecarSpawnFailure(message: string, cause?: unknown, phase?: "spawn" | "health"): Error {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause })
  return Object.assign(error, { code: SIDECAR_SPAWN_FAILED, ...(phase === undefined ? {} : { phase }) })
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

// A fully validated primary sidecar: the local path only produces one after
// its health check passed, the WSL path produces one only after a ready WSL
// server was selected. `wslFallback` tells the caller that a WSL server is
// backing the connection (in which case listener is null).
export type SidecarReady = {
  listener: { stop: () => Promise<void> } | null
  ready: ServerReadyData
  wslFallback: boolean
}

type LocalSidecarHandle = {
  listener: { stop: () => Promise<void> }
  health: { wait: Promise<void> }
}

export type SpawnLocalServer = (
  hostname: string,
  port: number,
  password: string,
  hooks: { onStdout: (message: string) => void; onStderr: (message: string) => void; onExit: (code: number) => void },
) => Promise<LocalSidecarHandle>

// Selection rule: the first READY entry in persisted array order, NOT the
// server that became ready earliest. Persisted order is the user-managed
// preference order in the WSL servers panel, so the fallback is deterministic
// instead of depending on flapping readiness transitions. (Each startServer
// emits its own state transition, so waitForWslServerReady resolves at the
// earliest ready transition; the array-order rule only decides when several
// entries are ready within one snapshot, e.g. the first poll after initialize.)
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

// Brings up the primary sidecar and validates it before returning.
//
// Decision domain (per platform/mode):
// - win32 + force: WSL primary only, local is never attempted.
// - any platform + native (including every non-win32 platform): local only,
//   failures propagate; no fallback.
// - win32 + auto: local first; a SIDECAR_SPAWN_FAILED at any phase (spawn or
//   API-ready health) kills the local sidecar and falls back to WSL.
//
// The local path waits for the sidecar's health check inside this decision
// domain: the `ready` IPC message only proves the listener socket is open, and
// a sidecar whose API never becomes healthy is useless to the renderer, so it
// is killed and the failure is routed exactly like a spawn failure instead of
// being delivered as an unverified ready URL.
export async function startPrimarySidecar(options: {
  platform: NodeJS.Platform
  mode: WslSidecarMode
  hostname: string
  port: number
  password: string
  healthTimeoutMs?: number
  spawnLocalServer: SpawnLocalServer
  startWslPrimary: (mode: WslSidecarMode) => Promise<SidecarReady>
  onStdout: (message: string) => void
  onStderr: (message: string) => void
  onExit: (code: number) => void
  onPlatformFallback: (reason: string) => void
}): Promise<SidecarReady> {
  const spawnLocal = async (): Promise<SidecarReady> => {
    const connection = await options.spawnLocalServer(options.hostname, options.port, options.password, {
      onStdout: options.onStdout,
      onStderr: options.onStderr,
      onExit: options.onExit,
    })
    try {
      await waitForLocalHealth(connection.health.wait, options.healthTimeoutMs ?? LOCAL_HEALTH_TIMEOUT_MS)
    } catch (error) {
      await connection.listener.stop().catch(() => undefined)
      throw sidecarSpawnFailure(
        `local sidecar health check failed: ${error instanceof Error ? error.message : String(error)}`,
        error,
        "health",
      )
    }
    return {
      listener: connection.listener,
      ready: {
        url: `http://${options.hostname}:${options.port}`,
        username: "deepagent-code",
        password: options.password,
      },
      wslFallback: false,
    }
  }

  if (options.platform === "win32" && options.mode === "force") {
    return options.startWslPrimary(options.mode)
  }

  try {
    return await spawnLocal()
  } catch (error) {
    if (options.platform !== "win32" || options.mode !== "auto" || !isSidecarSpawnFailure(error)) throw error
    options.onPlatformFallback(error instanceof Error ? error.message : String(error))
    return options.startWslPrimary(options.mode).catch((fallbackError) => {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      const reason = error instanceof Error ? error.message : String(error)
      const localPhase =
        (error as { phase?: string }).phase === "health"
          ? "local sidecar became ready but failed its health check"
          : "local sidecar spawn failed"
      throw sidecarSpawnFailure(`${localPhase} (${reason}); WSL fallback failed (${fallbackMessage})`, error)
    })
  }
}

export function waitForWslServerReady(
  wslServers: WslServersController,
  options: { timeoutMs?: number; mode?: WslSidecarMode } = {},
): Promise<WslServerReady> {
  const timeoutMs = options.timeoutMs ?? WSL_FALLBACK_TIMEOUT_MS
  const mode = options.mode ?? "auto"
  return new Promise<WslServerReady>((resolve, reject) => {
    let settled = false
    let unsubscribe: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    const settle = (action: () => void) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      unsubscribe?.()
      action()
    }

    const inspect = (state: WslServersState) => {
      const ready = firstReadyWslServer(state.servers)
      if (ready) {
        settle(() => resolve(ready))
        return
      }
      if (state.servers.length === 0) {
        settle(() =>
          reject(
            new Error(
              mode === "force" ? "no WSL server is configured" : "no WSL sidecar server is configured for fallback",
            ),
          ),
        )
        return
      }
      if (state.servers.every((item) => item.runtime.kind === "failed")) {
        settle(() => reject(new Error("every configured WSL sidecar failed to start")))
      }
    }

    unsubscribe = wslServers.subscribe((event) => inspect(event.state))
    timer = setTimeout(() => settle(() => reject(new Error(`WSL fallback timed out after ${timeoutMs}ms`))), timeoutMs)
    // initialize() runs refreshFromStore plus the per-server startServer loop
    // synchronously up to its first await, so the state read below already sees
    // the persisted servers marked starting and no transition can slip through.
    void wslServers.initialize().catch(() => undefined)
    inspect(wslServers.getState())
  })
}

function waitForLocalHealth(health: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`health check timed out after ${timeoutMs}ms`)), timeoutMs)
    health.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (error) => {
        clearTimeout(timer)
        reject(error as Error)
      },
    )
  })
}
