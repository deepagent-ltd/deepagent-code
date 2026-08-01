export * as LocationCommitLock from "./commit-lock"

import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Function, Layer, Schedule, Schema } from "effect"
import type { Scope } from "effect"
import { Hash } from "../util/hash"

export class TimeoutError extends Schema.TaggedErrorClass<TimeoutError>()("LocationCommitLock.TimeoutError", {
  key: Schema.String,
  mode: Schema.Literals(["shared", "exclusive"]),
}) {}

export class CompromisedError extends Schema.TaggedErrorClass<CompromisedError>()(
  "LocationCommitLock.CompromisedError",
  { key: Schema.String },
) {}

export type Error = TimeoutError | CompromisedError

export interface Interface {
  readonly acquireShared: (key: string) => Effect.Effect<void, Error, Scope.Scope>
  readonly acquireExclusive: (key: string) => Effect.Effect<void, Error, Scope.Scope>
  readonly withShared: {
    (key: string): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | Error, R>
    <A, E, R>(effect: Effect.Effect<A, E, R>, key: string): Effect.Effect<A, E | Error, R>
  }
  readonly withExclusive: {
    (key: string): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | Error, R>
    <A, E, R>(effect: Effect.Effect<A, E, R>, key: string): Effect.Effect<A, E | Error, R>
  }
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/LocationCommitLock") {}

export function layer(config: {
  readonly directory: string
  readonly timeoutMs?: number
  readonly staleMs?: number
  readonly pollMs?: number
}) {
  const timeoutMs = config.timeoutMs ?? 10_000
  const staleMs = config.staleMs ?? 60_000
  const pollMs = config.pollMs ?? 10
  if (![timeoutMs, staleMs, pollMs].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error("invalid Location commit lock timing")
  }
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(config.directory, { recursive: true, mode: 0o700 })).pipe(Effect.orDie)

      const acquire = (key: string, mode: "shared" | "exclusive") =>
        Effect.gen(function* () {
          const handle = yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: (signal) => acquireHandle({ directory: config.directory, key, mode, timeoutMs, staleMs, pollMs, signal }),
              catch: (error) => error instanceof TimeoutError ? error : new CompromisedError({ key }),
            }),
            (handle) => Effect.promise(() => release(handle)).pipe(Effect.orDie),
          )
          yield* Effect.promise(() => touch(handle.heartbeat)).pipe(
            Effect.ignore,
            Effect.repeat(Schedule.spaced(Math.max(10, Math.floor(staleMs / 3)))),
            Effect.forkScoped,
          )
        })

      const acquireShared = (key: string) => acquire(key, "shared")
      const acquireExclusive = (key: string) => acquire(key, "exclusive")
      const withShared: Interface["withShared"] = Function.dual(
        (args) => Effect.isEffect(args[0]),
        <A, E, R>(effect: Effect.Effect<A, E, R>, key: string) =>
          Effect.scoped(acquireShared(key).pipe(Effect.andThen(effect))),
      )
      const withExclusive: Interface["withExclusive"] = Function.dual(
        (args) => Effect.isEffect(args[0]),
        <A, E, R>(effect: Effect.Effect<A, E, R>, key: string) =>
          Effect.scoped(acquireExclusive(key).pipe(Effect.andThen(effect))),
      )
      return Service.of({ acquireShared, acquireExclusive, withShared, withExclusive })
    }),
  )
}

type Handle = {
  readonly directory: string
  readonly metadata: string
  readonly heartbeat: string
  readonly token: string
}

async function acquireHandle(input: {
  readonly directory: string
  readonly key: string
  readonly mode: "shared" | "exclusive"
  readonly timeoutMs: number
  readonly staleMs: number
  readonly pollMs: number
  readonly signal: AbortSignal
}) {
  const root = path.join(input.directory, Hash.sha256(`location-commit-lock/v1:${input.key}`))
  await mkdir(path.join(root, "readers"), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + input.timeoutMs
  if (input.mode === "shared") return acquireReader(root, input, deadline)
  return acquireWriter(root, input, deadline)
}

async function acquireReader(
  root: string,
  input: Parameters<typeof acquireHandle>[0],
  deadline: number,
): Promise<Handle> {
  while (Date.now() < deadline) {
    input.signal.throwIfAborted()
    await cleanStaleWriter(root, input.staleMs)
    if (await exists(path.join(root, "writer"))) {
      await delay(input.pollMs, input.signal)
      continue
    }
    const token = randomUUID()
    const directory = path.join(root, "readers", token)
    await mkdir(directory, { mode: 0o700 })
    const handle = await initializeHandle(directory, token)
    if (!(await exists(path.join(root, "writer")))) return handle
    await release(handle)
    await delay(input.pollMs, input.signal)
  }
  throw new TimeoutError({ key: input.key, mode: "shared" })
}

async function acquireWriter(
  root: string,
  input: Parameters<typeof acquireHandle>[0],
  deadline: number,
): Promise<Handle> {
  const directory = path.join(root, "writer")
  let handle: Handle | undefined
  while (Date.now() < deadline) {
    input.signal.throwIfAborted()
    await cleanStaleWriter(root, input.staleMs)
    const token = randomUUID()
    try {
      await mkdir(directory, { mode: 0o700 })
      handle = await initializeHandle(directory, token)
      break
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
      await delay(input.pollMs, input.signal)
    }
  }
  if (!handle) throw new TimeoutError({ key: input.key, mode: "exclusive" })
  while (Date.now() < deadline) {
    input.signal.throwIfAborted()
    await touch(handle.heartbeat)
    await cleanStaleReaders(root, input.staleMs)
    if ((await readdir(path.join(root, "readers"))).length === 0) return handle
    await delay(input.pollMs, input.signal)
  }
  await release(handle)
  throw new TimeoutError({ key: input.key, mode: "exclusive" })
}

async function initializeHandle(directory: string, token: string): Promise<Handle> {
  const metadata = path.join(directory, "metadata.json")
  const heartbeat = path.join(directory, "heartbeat")
  await writeFile(metadata, JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }), { flag: "wx" })
  await writeFile(heartbeat, "", { flag: "wx" })
  return { directory, metadata, heartbeat, token }
}

async function release(handle: Handle) {
  const value = await readFile(handle.metadata, "utf8").then(JSON.parse).catch(() => undefined)
  if (value?.token !== handle.token) return
  await rm(handle.directory, { recursive: true, force: true })
}

async function cleanStaleWriter(root: string, staleMs: number) {
  const directory = path.join(root, "writer")
  if (!(await stale(path.join(directory, "heartbeat"), directory, staleMs))) return
  const breaker = path.join(root, "writer-breaker")
  try {
    await mkdir(breaker, { mode: 0o700 })
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
    if (await stale(breaker, breaker, staleMs)) await rm(breaker, { recursive: true, force: true })
    return
  }
  try {
    if (await stale(path.join(directory, "heartbeat"), directory, staleMs)) {
      await rm(directory, { recursive: true, force: true })
    }
  } finally {
    await rm(breaker, { recursive: true, force: true })
  }
}

async function cleanStaleReaders(root: string, staleMs: number) {
  const readers = path.join(root, "readers")
  await Promise.all(
    (await readdir(readers)).map(async (entry) => {
      const directory = path.join(readers, entry)
      if (await stale(path.join(directory, "heartbeat"), directory, staleMs)) {
        await rm(directory, { recursive: true, force: true })
      }
    }),
  )
}

async function stale(heartbeat: string, directory: string, staleMs: number) {
  const value = await stat(heartbeat).catch(() => stat(directory).catch(() => undefined))
  return Boolean(value && Date.now() - value.mtimeMs > staleMs)
}

async function exists(value: string) {
  return stat(value).then(() => true).catch(() => false)
}

async function touch(value: string) {
  const now = new Date()
  await utimes(value, now, now)
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

function isAlreadyExists(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST")
}
