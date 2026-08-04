import fs from "node:fs"
import path from "node:path"
import { Global } from "@deepagent-code/core/global"
import { Hash } from "@deepagent-code/core/util/hash"

export interface DurableExecutorLease {
  readonly directory: string
  readonly lockPath: string
  readonly content: string
}

const processReservations = new Set<string>()

export function durableExecutorLockPath(directory: string, stateRoot = Global.Path.state) {
  const workspaceID = Hash.sha256(path.resolve(directory))
  return path.join(stateRoot, "locks", "durable-executor", `${workspaceID}.lock`)
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

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: any) {
    return error?.code !== "ESRCH"
  }
}

/** Acquire the cross-process lease after reserveDurableExecutor succeeds. */
export function acquireDurableExecutorLease(input: {
  directory: string
  mode: string
  stateRoot?: string
}): DurableExecutorLease | undefined {
  const lockPath = durableExecutorLockPath(input.directory, input.stateRoot)
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  const content = `${process.pid}\n${Date.now()}\n${input.mode}\n`

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, content, { flag: "wx", mode: 0o600 })
      return { directory: input.directory, lockPath, content }
    } catch (error: any) {
      if (error?.code !== "EEXIST") return undefined
      try {
        const existing = fs.readFileSync(lockPath, "utf-8")
        const [existingPIDText] = existing.split("\n")
        const existingPID = Number.parseInt(existingPIDText, 10)
        if (!Number.isSafeInteger(existingPID) || processIsAlive(existingPID)) return undefined
        fs.unlinkSync(lockPath)
      } catch (readError: any) {
        if (readError?.code !== "ENOENT") return undefined
      }
    }
  }
  return undefined
}

/** Release only the exact lease token we acquired; never unlink a successor's lock. */
export function releaseDurableExecutorLease(lease: DurableExecutorLease) {
  try {
    const current = fs.readFileSync(lease.lockPath, "utf-8")
    if (current === lease.content) fs.unlinkSync(lease.lockPath)
  } catch {
    // Already gone or replaced by an unreadable successor: leave it untouched.
  } finally {
    releaseDurableExecutorReservation(lease.directory)
  }
}
