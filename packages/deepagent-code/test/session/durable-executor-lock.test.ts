import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  acquireDurableExecutorLease,
  durableExecutorLockPath,
  releaseDurableExecutorLease,
  releaseDurableExecutorReservation,
  reserveDurableExecutor,
} from "@/session/durable-executor-lock"

const roots: string[] = []

function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepagent-durable-lock-"))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("durable executor topology lock", () => {
  test("uses stable product state paths without polluting the workspace", () => {
    const root = temporaryRoot()
    const workspace = path.join(root, "workspace")
    const state = path.join(root, "state")
    fs.mkdirSync(workspace)

    const lockPath = durableExecutorLockPath(workspace, state)
    expect(lockPath.startsWith(`${state}${path.sep}`)).toBe(true)
    expect(lockPath).toBe(durableExecutorLockPath(workspace, state))
    expect(lockPath).not.toContain(`${workspace}${path.sep}`)
  })

  test("serializes same-process startup before asynchronous lease acquisition", () => {
    const workspace = path.join(temporaryRoot(), "workspace")
    expect(reserveDurableExecutor(workspace)).toBe(true)
    expect(reserveDurableExecutor(workspace)).toBe(false)
    releaseDurableExecutorReservation(workspace)
    expect(reserveDurableExecutor(workspace)).toBe(true)
    releaseDurableExecutorReservation(workspace)
  })

  test("acquires in state storage and releases only its own token", () => {
    const root = temporaryRoot()
    const workspace = path.join(root, "workspace")
    const state = path.join(root, "state")
    fs.mkdirSync(workspace)
    expect(reserveDurableExecutor(workspace)).toBe(true)

    const lease = acquireDurableExecutorLease({ directory: workspace, mode: "durable", stateRoot: state })
    expect(lease).toBeDefined()
    expect(fs.existsSync(path.join(workspace, ".deepagent-executor.lock"))).toBe(false)
    expect(fs.readFileSync(lease!.lockPath, "utf-8")).toBe(lease!.content)

    releaseDurableExecutorLease(lease!)
    expect(fs.existsSync(lease!.lockPath)).toBe(false)
    expect(reserveDurableExecutor(workspace)).toBe(true)
    releaseDurableExecutorReservation(workspace)
  })

  test("does not unlink a successor token during cleanup", () => {
    const root = temporaryRoot()
    const workspace = path.join(root, "workspace")
    expect(reserveDurableExecutor(workspace)).toBe(true)
    const lease = acquireDurableExecutorLease({ directory: workspace, mode: "durable", stateRoot: root })!
    fs.writeFileSync(lease.lockPath, "successor-token\n")

    releaseDurableExecutorLease(lease)
    expect(fs.readFileSync(lease.lockPath, "utf-8")).toBe("successor-token\n")
  })
})
