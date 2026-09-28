import type { ServerReadyData } from "../preload/types"

// Error code attached to any failure to bring the primary sidecar up (fork
// error, ready-message timeout, early exit, sidecar-reported start error, or a
// failed API-ready health check).
export const SIDECAR_SPAWN_FAILED = "SIDECAR_SPAWN_FAILED"

// The API-ready health wait does NOT use a fixed wall-clock budget: between
// listener-open and healthy the sidecar opens the database and runs pending
// migrations, and that duration grows with the user's data — any fixed number
// is eventually too small for someone's first launch after an upgrade. Instead
// the wait is bounded by SILENCE: as long as the sidecar keeps producing
// output (migration logs, bootstrap messages), the watchdog keeps waiting;
// only a process that goes quiet for this long without answering health is
// declared hung. A hard cap remains available through
// DEEPAGENT_CODE_SIDECAR_HEALTH_TIMEOUT_MS for field diagnosis.
export const LOCAL_HEALTH_SILENCE_MS = Number(process.env.DEEPAGENT_CODE_SIDECAR_HEALTH_TIMEOUT_MS) || 20_000

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
  // Sidecar output is progress: feed every line to the health watchdog so a
  // long-but-working startup (big database, many pending migrations) keeps
  // refreshing the silence window while still surfacing the caller's hooks.
  let markProgress: (() => void) | undefined
  const delegate = (hook: (message: string) => void) => (message: string) => {
    markProgress?.()
    hook(message)
  }
  const spawnHooks = {
    onStdout: delegate(options.onStdout),
    onStderr: delegate(options.onStderr),
    onExit: options.onExit,
  }
  const connection = await options.spawnLocalServer(options.hostname, options.port, options.password, spawnHooks)
  try {
    await waitForLocalHealth(connection.health.wait, options.healthTimeoutMs ?? LOCAL_HEALTH_SILENCE_MS, (refresh) => {
      markProgress = refresh
    })
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

function waitForLocalHealth(
  health: Promise<void>,
  silenceMs: number,
  onWatchdog: (refresh: () => void) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      clearTimeout(timer)
      timer = setTimeout(() => reject(new Error(`sidecar made no progress for ${silenceMs}ms while waiting for health`)), silenceMs)
    }
    onWatchdog(refresh)
    refresh()
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
