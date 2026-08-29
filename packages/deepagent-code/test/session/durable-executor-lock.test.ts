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
    expect(JSON.parse(fs.readFileSync(lease!.metadataPath, "utf-8")).token).toBe(lease!.token)

    releaseDurableExecutorLease(lease!)
    expect(fs.existsSync(lease!.lockPath)).toBe(false)
    expect(reserveDurableExecutor(workspace)).toBe(true)
    releaseDurableExecutorReservation(workspace)
  })

  test("quarantines a stale dead-owner lease without deleting a successor", () => {
    const root = temporaryRoot()
    const workspace = path.join(root, "workspace")
    expect(reserveDurableExecutor(workspace)).toBe(true)
    const first = acquireDurableExecutorLease({
      directory: workspace,
      mode: "durable",
      stateRoot: root,
      staleMs: 20,
      heartbeatMs: 1_000,
    })!
    clearInterval(first.heartbeat)
    const old = new Date(Date.now() - 1_000)
    fs.utimesSync(first.heartbeatPath, old, old)
    fs.writeFileSync(
      first.metadataPath,
      JSON.stringify({ token: first.token, pid: 2_147_483_647, createdAt: Date.now() - 1_000, mode: "durable" }),
    )
    releaseDurableExecutorReservation(workspace)

    expect(reserveDurableExecutor(workspace)).toBe(true)
    const successor = acquireDurableExecutorLease({
      directory: workspace,
      mode: "durable",
      stateRoot: root,
      staleMs: 20,
    })!
    expect(successor.token).not.toBe(first.token)

    releaseDurableExecutorLease(first)
    expect(JSON.parse(fs.readFileSync(successor.metadataPath, "utf-8")).token).toBe(successor.token)
    releaseDurableExecutorLease(successor)
  })

  test("allows only one live owner across real processes", async () => {
    const root = temporaryRoot()
    const workspace = path.join(root, "workspace")
    const worker = path.join(import.meta.dir, "../fixture/durable-executor-lock-worker.ts")
    const firstResult = path.join(root, "first.json")
    const secondResult = path.join(root, "second.json")
    const thirdResult = path.join(root, "third.json")
    fs.mkdirSync(workspace)

    const first = Bun.spawn([process.execPath, worker, root, workspace, firstResult, "500", "20", "1000"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    await waitForFile(firstResult)
    expect(JSON.parse(fs.readFileSync(firstResult, "utf-8")).acquired).toBe(true)
    await Bun.sleep(50)

    const second = Bun.spawn([process.execPath, worker, root, workspace, secondResult, "0", "20", "1000"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await second.exited).toBe(0)
    expect(JSON.parse(fs.readFileSync(secondResult, "utf-8")).acquired).toBe(false)
    expect(await first.exited).toBe(0)

    const third = Bun.spawn([process.execPath, worker, root, workspace, thirdResult, "0", "20", "1000"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await third.exited).toBe(0)
    expect(JSON.parse(fs.readFileSync(thirdResult, "utf-8")).acquired).toBe(true)
  })
})

async function waitForFile(file: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fs.existsSync(file)) return
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${file}`)
}
