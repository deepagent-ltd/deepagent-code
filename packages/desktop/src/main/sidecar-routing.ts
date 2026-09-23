import type { ServerReadyData } from "../preload/types"

// Error code attached to any failure to bring the primary sidecar up (fork
// error, ready-message timeout, early exit, sidecar-reported start error, or a
// failed API-ready health check).
export const SIDECAR_SPAWN_FAILED = "SIDECAR_SPAWN_FAILED"

// Budget for the local sidecar's API-ready health wait. The `ready` IPC message
// only proves the listener socket is open, so startPrimarySidecar waits for the
// health endpoint to answer before handing the URL to the renderer.
export const LOCAL_HEALTH_TIMEOUT_MS = 15_000

export function sidecarSpawnFailure(message: string, cause?: unknown, phase?: "spawn" | "health"): Error {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause })
  return Object.assign(error, { code: SIDECAR_SPAWN_FAILED, ...(phase === undefined ? {} : { phase }) })
}

export function isSidecarSpawnFailure(error: unknown): boolean {
  return error instanceof Error && (error as Error & { code?: unknown }).code === SIDECAR_SPAWN_FAILED
}

export type SidecarReady = {
  listener: { stop: () => Promise<void> }
  ready: ServerReadyData
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

// Brings up the primary sidecar and validates it before returning. The wait
// for the health endpoint runs inside this decision domain: the `ready` IPC
// message only proves the listener socket is open, and a sidecar whose API
// never becomes healthy is useless to the renderer, so it is killed and the
// failure is routed exactly like a spawn failure instead of being delivered as
// an unverified ready URL. Routing is native-only on every platform — a local
// spawn failure propagates to the caller with no fallback.
export async function startPrimarySidecar(options: {
  hostname: string
  port: number
  password: string
  healthTimeoutMs?: number
  spawnLocalServer: SpawnLocalServer
  onStdout: (message: string) => void
  onStderr: (message: string) => void
  onExit: (code: number) => void
}): Promise<SidecarReady> {
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
  }
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
