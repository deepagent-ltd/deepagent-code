import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Global } from "@deepagent-code/core/global"
import { Hash } from "@deepagent-code/core/util/hash"

export interface DurableExecutorLease {
  readonly directory: string
  readonly lockPath: string
  readonly metadataPath: string
  readonly heartbeatPath: string
  readonly token: string
  readonly heartbeat: ReturnType<typeof setInterval>
  readonly staleMs: number
}

type LeaseMetadata = {
  readonly token: string
  readonly pid: number
  readonly createdAt: number
  readonly mode: string
}

const processReservations = new Set<string>()
const defaultStaleMs = 60_000

export function durableExecutorLockPath(directory: string, stateRoot = Global.Path.state) {
  return path.join(stateRoot, "locks", "durable-executor", `${Hash.sha256(path.resolve(directory))}.lock`)
}

/** Reserve one durable executor per workspace before asynchronous startup can race. */
export function reserveDurableExecutor(directory: string) {
  const key = path.resolve(directory)
  if (processReservations.has(key)) return false
  processReservations.add(key)
  return true
}

export function releaseDurableExecutorReservation(directory: string) {
  processReservations.delete(path.resolve(directory))
}

/** Acquire the cross-process lease after reserveDurableExecutor succeeds. */
export function acquireDurableExecutorLease(input: {
  readonly directory: string
  readonly mode: string
  readonly stateRoot?: string
  readonly staleMs?: number
  readonly heartbeatMs?: number
}): DurableExecutorLease | undefined {
  const lockPath = durableExecutorLockPath(input.directory, input.stateRoot)
  const staleMs = input.staleMs ?? defaultStaleMs
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 })

  for (let attempt = 0; attempt < 3; attempt++) {
    const breakerPath = acquireBreaker(lockPath, staleMs)
    if (!breakerPath) return
    try {
      try {
        fs.mkdirSync(lockPath, { mode: 0o700 })
      } catch (error) {
        if (!hasCode(error, "EEXIST")) return
        if (!leaseIsStale(lockPath, staleMs)) {
          warnLiveStaleLeaseHolder({ directory: input.directory, lockPath, staleMs })
          return
        }
        if (!quarantineStaleLease(lockPath)) continue
        fs.mkdirSync(lockPath, { mode: 0o700 })
      }

      const token = randomUUID()
      const metadataPath = path.join(lockPath, "meta.json")
      const heartbeatPath = path.join(lockPath, "heartbeat")
      try {
        fs.writeFileSync(
          metadataPath,
          JSON.stringify({ token, pid: process.pid, createdAt: Date.now(), mode: input.mode } satisfies LeaseMetadata),
          { flag: "wx", mode: 0o600 },
        )
        fs.writeFileSync(heartbeatPath, "", { flag: "wx", mode: 0o600 })
      } catch {
        fs.rmSync(lockPath, { recursive: true, force: true })
        return
      }

      const heartbeat = setInterval(
        () => {
          const heartbeatBreaker = acquireBreaker(lockPath, staleMs)
          if (!heartbeatBreaker) return
          try {
            const current = readMetadata(metadataPath)
            if (current?.token !== token) {
              clearInterval(heartbeat)
              return
            }
            const now = new Date()
            fs.utimesSync(heartbeatPath, now, now)
          } catch {
            clearInterval(heartbeat)
          } finally {
            releaseBreaker(heartbeatBreaker)
          }
        },
        input.heartbeatMs ?? Math.max(100, Math.floor(staleMs / 3)),
      )
      heartbeat.unref()
      return { directory: input.directory, lockPath, metadataPath, heartbeatPath, token, heartbeat, staleMs }
    } finally {
      releaseBreaker(breakerPath)
    }
  }
}

/** Release only the exact lease token we acquired; never unlink a successor's lock. */
export function releaseDurableExecutorLease(lease: DurableExecutorLease) {
  clearInterval(lease.heartbeat)
  const breakerPath = acquireBreaker(lease.lockPath, lease.staleMs)
  try {
    if (!breakerPath) return
    if (readMetadata(lease.metadataPath)?.token !== lease.token) return
    const quarantine = `${lease.lockPath}.release-${lease.token}`
    fs.renameSync(lease.lockPath, quarantine)
    fs.rmSync(quarantine, { recursive: true, force: true })
  } catch {
    // Already gone or replaced by a successor: leave the current lease untouched.
  } finally {
    if (breakerPath) releaseBreaker(breakerPath)
    releaseDurableExecutorReservation(lease.directory)
  }
}

/**
 * Alert when a lease is past its staleness window but its owner process is still alive, so the
 * fail-closed refusal in leaseIsStale is observable instead of a silent startup stall.
 */
function warnLiveStaleLeaseHolder(input: { readonly directory: string; readonly lockPath: string; readonly staleMs: number }) {
  const metadata = readMetadata(path.join(input.lockPath, "meta.json"))
  if (!metadata || !processIsAlive(metadata.pid)) return
  let leaseAgeMs: number | undefined
  try {
    leaseAgeMs = Date.now() - fs.statSync(path.join(input.lockPath, "heartbeat")).mtimeMs
  } catch (error) {
    if (!hasCode(error, "ENOENT")) return
  }
  if (leaseAgeMs === undefined) {
    try {
      leaseAgeMs = Date.now() - fs.statSync(input.lockPath).mtimeMs
    } catch {
      return
    }
  }
  if (leaseAgeMs <= input.staleMs) return
  console.warn("[durable-executor-lock] stale lease held by a live process; refusing takeover (fail-closed)", {
    workspace: input.directory,
    pid: metadata.pid,
    leaseAgeMs,
    staleMs: input.staleMs,
    lockPath: input.lockPath,
  })
}

function quarantineStaleLease(lockPath: string) {
  const quarantine = `${lockPath}.stale-${randomUUID()}`
  try {
    fs.renameSync(lockPath, quarantine)
  } catch {
    return false
  }
  fs.rmSync(quarantine, { recursive: true, force: true })
  return true
}

function acquireBreaker(lockPath: string, staleMs: number) {
  const breakerPath = `${lockPath}.breaker`
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(breakerPath, { mode: 0o700 })
      return breakerPath
    } catch (error) {
      if (!hasCode(error, "EEXIST")) return
    }
    try {
      if (Date.now() - fs.statSync(breakerPath).mtimeMs <= Math.max(staleMs, 1_000)) return
      const quarantine = `${breakerPath}.stale-${randomUUID()}`
      fs.renameSync(breakerPath, quarantine)
      fs.rmSync(quarantine, { recursive: true, force: true })
    } catch (error) {
      if (!hasCode(error, "ENOENT")) return
    }
  }
}

function releaseBreaker(breakerPath: string) {
  fs.rmSync(breakerPath, { recursive: true, force: true })
}

function leaseIsStale(lockPath: string, staleMs: number) {
  const metadata = readMetadata(path.join(lockPath, "meta.json"))
  // Until execution ownership has a process-independent epoch, a live process must never be
  // replaced solely because its event loop missed heartbeats. Fail closed instead of risking two
  // legacy Session runtimes against the same SQLite/Location.
  if (metadata && processIsAlive(metadata.pid)) return false
  try {
    const heartbeat = fs.statSync(path.join(lockPath, "heartbeat"))
    return Date.now() - heartbeat.mtimeMs > staleMs
  } catch (error) {
    if (!hasCode(error, "ENOENT")) return false
  }
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs > staleMs
  } catch {
    return false
  }
}

function processIsAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !hasCode(error, "ESRCH")
  }
}

function readMetadata(metadataPath: string) {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(metadataPath, "utf-8"))
    if (!value || typeof value !== "object") return
    if (!("token" in value) || typeof value.token !== "string") return
    if (!("pid" in value) || typeof value.pid !== "number") return
    if (!("createdAt" in value) || typeof value.createdAt !== "number") return
    if (!("mode" in value) || typeof value.mode !== "string") return
    return value as LeaseMetadata
  } catch {
    return
  }
}

function hasCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code
}
