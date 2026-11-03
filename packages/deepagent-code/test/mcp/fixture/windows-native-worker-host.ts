import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { isMainThread, parentPort, threadId, Worker } from "node:worker_threads"
import { Effect } from "effect"
import { NativeWindowsBootstrap } from "../../../src/installation/windows-native-bootstrap"

const phase = (name: string) =>
  fs.appendFile(
    path.join(process.env.DAC_NATIVE_NODE_COHORT_ROOT!, "worker-phases.jsonl"),
    `${JSON.stringify({ phase: name, at: Date.now() })}\n`,
  )

export async function main() {
  await NativeWindowsBootstrap.installFixedEntry()
  const parent = await Effect.runPromise(NativeWindowsBootstrap.Registered)
  assert(parent && parent.preloaded(parent.capture) && parent.current(parent.capture))
  await phase("parent-preloaded")
  const marker = NativeWindowsBootstrap.bindWorker()
  assert(marker)
  await phase("worker-marker-bound")
  const worker = new Worker(new URL(import.meta.url), {
    env: { ...process.env, DAC_NATIVE_PRELOAD_HANDLES: marker },
  })
  try {
    const proof = await new Promise<{
      preloaded: boolean
      current: boolean
      pid: number
      realWorker: boolean
      markerConsumed: boolean
    }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Native worker receipt proof timed out")), 15000)
      worker.once(
        "message",
        (value: {
          preloaded: boolean
          current: boolean
          pid: number
          realWorker: boolean
          markerConsumed: boolean
        }) => {
          clearTimeout(timer)
          resolve(value)
        },
      )
      worker.once("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
      worker.once("exit", (code) => {
        if (code === 0) return
        clearTimeout(timer)
        reject(new Error(`Native worker exited before receipt proof: ${code}`))
      })
    })
    assert.deepEqual(proof, {
      preloaded: true,
      current: true,
      pid: process.pid,
      realWorker: true,
      markerConsumed: true,
    })
    await fs.writeFile(
      path.join(process.env.DAC_NATIVE_NODE_COHORT_ROOT!, "worker-receipt.json"),
      JSON.stringify({
        parentPreloaded: parent.preloaded(parent.capture),
        parentCurrent: parent.current(parent.capture),
        workerPreloaded: proof.preloaded,
        workerCurrent: proof.current,
        sameProcess: proof.pid === process.pid,
        realWorker: proof.realWorker,
        workerMarkerConsumed: proof.markerConsumed,
      }),
    )
  } finally {
    await worker.terminate()
    NativeWindowsBootstrap.closeWorker(marker)
  }
}

async function proveWorker() {
  assert(parentPort && threadId !== 0)
  await phase(`worker-start-marker-${process.env.DAC_NATIVE_PRELOAD_HANDLES ? "present" : "absent"}`)
  await NativeWindowsBootstrap.installFixedEntry()
  await phase("worker-installed")
  const native = await Effect.runPromise(NativeWindowsBootstrap.Registered)
  assert(native)
  parentPort.postMessage({
    preloaded: native.preloaded(native.capture),
    current: native.current(native.capture),
    pid: process.pid,
    realWorker: true,
    markerConsumed: process.env.DAC_NATIVE_PRELOAD_HANDLES === undefined,
  })
}

if (!isMainThread) await proveWorker()
