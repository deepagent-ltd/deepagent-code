export * as TypeScriptIndex from "./typescript-index"

import type { CodeGraph } from "@deepagent-code/core/code-intelligence/code-graph"
import { Effect, Semaphore } from "effect"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Worker } from "node:worker_threads"
import type { File } from "./manifest"

declare const DEEPAGENT_CODE_INDEX_WORKER_PATH: string

export type Request = {
  version: 1
  requestID: string
  root: string
  files: readonly File[]
}

type Response = { version: 1; requestID: string; build: CodeGraph.Build }

// A semantic program can retain several GB. All Locations share one build slot,
// including worker termination, rather than allocating a compiler per request.
const capacity = Semaphore.makeUnsafe(1)
const live = new Set<Worker>()

export const activity = () => ({ active: live.size })

export const build = Effect.fn("TypeScriptIndex.build")(function* (input: { root: string; files: readonly File[] }) {
  return yield* capacity.withPermits(1)(
    Effect.scoped(
      Effect.gen(function* () {
        const job = yield* Effect.acquireRelease(
          Effect.try({ try: () => start(input), catch: () => new Error("Semantic index worker could not start") }),
          (job) =>
            Effect.promise(async () => {
              try {
                await job.worker.terminate()
              } finally {
                await job.exited
              }
            }),
        )
        return yield* Effect.tryPromise(() => job.completed)
      }),
    ),
  )
})

function asset() {
  if (typeof DEEPAGENT_CODE_INDEX_WORKER_PATH !== "undefined") return DEEPAGENT_CODE_INDEX_WORKER_PATH
  const filename = fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts") ? "./typescript-index.worker.ts" : "./typescript-index.worker.js",
      import.meta.url,
    ),
  )
  // Node Worker loaders need the physical sibling outside Electron's ASAR.
  return pathToFileURL(filename.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`))
}

function start(input: { root: string; files: readonly File[] }) {
  const requestID = randomUUID()
  const worker = new Worker(asset(), {
    workerData: { version: 1, requestID, root: input.root, files: input.files } satisfies Request,
    env: {},
    execArgv: [],
    stdout: true,
    stderr: true,
  })
  live.add(worker)
  worker.stdout.resume()
  worker.stderr.resume()
  const exited = Promise.withResolvers<number>()
  const completed = Promise.withResolvers<CodeGraph.Build>()
  const state: { response?: Response; failed: boolean; error?: Error } = { failed: false }
  const stop = (error?: Error) => {
    state.failed = true
    state.error = error
    void worker.terminate().catch(() => undefined)
  }
  worker.once("error", stop)
  worker.on("message", (value: Response) => {
    if (
      state.response ||
      value?.version !== 1 ||
      value.requestID !== requestID ||
      !value.build ||
      !Array.isArray(value.build.files) ||
      !Array.isArray(value.build.edges) ||
      !Array.isArray(value.build.externalEntities) ||
      !Array.isArray(value.build.aliases)
    ) {
      stop()
      return
    }
    state.response = value
  })
  worker.once("exit", (code) => {
    live.delete(worker)
    exited.resolve(code)
    if (state.failed || code !== 0 || !state.response) {
      completed.reject(new Error("Semantic index worker did not complete", { cause: state.error }))
      return
    }
    completed.resolve(state.response.build)
  })
  // A scope may be cancelled before its use phase installs the result waiter.
  void completed.promise.catch(() => undefined)
  return { worker, exited: exited.promise, completed: completed.promise }
}
