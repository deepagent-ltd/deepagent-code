import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { identity } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import * as Client from "effect/unstable/sql/SqlClient"
import type { Connection } from "effect/unstable/sql/SqlConnection"
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError"
import * as Statement from "effect/unstable/sql/Statement"
import { Sqlite } from "./sqlite"

// Worker-backed Sqlite backend: the SQLite connection lives on a dedicated worker thread and the
// main thread talks to it over postMessage. Every statement becomes an async Effect, so a slow
// fsync (synchronous=FULL on a slow filesystem) can no longer starve the event loop — measured
// multi-minute heartbeat gaps under exactly this condition during long provider turns. Statement
// ordering is preserved (the worker serves one message at a time), which keeps the single-
// connection transaction discipline the SqlClient semaphore already provides.

const ATTR_DB_SYSTEM_NAME = "db.system.name"

const TypeId = "~@deepagent-code/core/database/SqliteBunWorker" as const
type TypeId = typeof TypeId

interface SqliteClient extends Client.SqlClient {
  readonly [TypeId]: TypeId
  readonly config: Config
  readonly export: Effect.Effect<Uint8Array, SqlError>
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
  readonly updateValues: never
}

interface Config {
  readonly filename: string
  readonly readonly?: boolean
  readonly create?: boolean
  readonly readwrite?: boolean
  readonly disableWAL?: boolean
  readonly spanAttributes?: Record<string, unknown>
  readonly transformResultNames?: (str: string) => string
  readonly transformQueryNames?: (str: string) => string
}

interface SqliteConnection extends Connection {
  readonly export: Effect.Effect<Uint8Array, SqlError>
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
}

// Self-contained worker source: opened via node:worker_threads eval so a compiled single-file
// binary needs no extra asset on disk.
const workerSource = `
const { parentPort } = require("node:worker_threads")
const { Database } = require("bun:sqlite")
let db = undefined
const reply = (id, ok, result) => parentPort.postMessage({ id, ok, result })
parentPort.on("message", (message) => {
  const { id, op } = message
  try {
    if (op === "open") {
      db = new Database(message.filename, {
        readonly: message.readonly === true,
        readwrite: message.readwrite !== false,
        create: message.create !== false,
        // Concurrent embeds on one path serialize through the file lock; without a busy timeout the
        // WAL pragma below fails immediately against a peer that is still setting WAL up.
        timeout: 5000,
      })
      if (message.disableWAL !== true) {
        for (let attempt = 0; ; attempt++) {
          try {
            db.run("PRAGMA journal_mode = WAL;")
            break
          } catch (cause) {
            if (attempt >= 10 || !String(cause).includes("locked")) throw cause
            // Dedicated thread: a short busy spin is safe and avoids suspending the worker.
            const until = performance.now() + 100
            while (performance.now() < until) {}
          }
        }
      }
      reply(id, true, { filename: message.filename })
      return
    }
    if (db === undefined) throw new Error("worker database is not open")
    if (op === "exec") {
      db.exec(message.sql)
      reply(id, true, null)
      return
    }
    if (op === "serialize") {
      reply(id, true, db.serialize())
      return
    }
    const statement = db.query(message.sql)
    statement.safeIntegers(message.bigInts === true)
    if (op === "values") {
      const rows = (statement.values(...(message.params ?? [])) ?? []).map((row) => [...row])
      reply(id, true, rows)
      return
    }
    reply(id, true, statement.all(...(message.params ?? [])) ?? [])
  } catch (cause) {
    reply(id, false, { message: String(cause?.message ?? cause), name: cause?.name, code: cause?.code })
  }
})
`

const make = (options: Config) =>
  Effect.gen(function* () {
    const { Worker } = yield* Effect.promise(() => import("node:worker_threads"))

    const compiler = Statement.makeCompilerSqlite(options.transformQueryNames)
    const transformRows = options.transformResultNames
      ? Statement.defaultTransforms(options.transformResultNames).array
      : undefined

    const worker = new Worker(workerSource, { eval: true })
    let nextId = 0
    const pending = new Map<number, { resolve: (value: any) => void; reject: (cause: unknown) => void }>()
    worker.on("message", (message: { id: number; ok: boolean; result: any }) => {
      const waiter = pending.get(message.id)
      if (waiter === undefined) return
      pending.delete(message.id)
      if (message.ok) waiter.resolve(message.result)
      else waiter.reject(new Error(message.result?.message ?? "sqlite worker failure"))
    })
    let dead: unknown | undefined
    worker.on("error", (cause: unknown) => {
      dead = cause
      for (const waiter of pending.values()) waiter.reject(cause)
      pending.clear()
    })
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => worker.terminate().then(() => undefined)).pipe(Effect.orDie),
    )

    const sqlError = (cause: unknown) =>
      new SqlError({
        reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
      })

    const call = <A>(op: string, extra: Record<string, unknown> = {}): Effect.Effect<A, SqlError> =>
      Effect.withFiber<A, SqlError>((fiber) => {
        if (dead !== undefined) return Effect.fail(sqlError(dead))
        const bigInts = Context.get(fiber.context, Client.SafeIntegers) === true
        const id = ++nextId
        return Effect.callback<A, SqlError>((resume) => {
          pending.set(id, {
            resolve: (value) => resume(Effect.succeed(value)),
            reject: (cause) => resume(Effect.fail(sqlError(cause))),
          })
          worker.postMessage({ id, op, bigInts, ...extra })
        })
      })

    const opened = yield* call<{ filename: string }>("open", {
      filename: options.filename,
      readonly: options.readonly,
      create: options.create,
      readwrite: options.readwrite,
      disableWAL: options.disableWAL,
    })

    const nativeLike = { filename: opened?.filename ?? options.filename }

    const run = (query: string, params: ReadonlyArray<unknown> = []) =>
      params.length === 0 && !/select|pragma/i.test(query)
        ? call("exec", { sql: query }).pipe(Effect.as([] as Array<Record<string, unknown>>))
        : call<Array<Record<string, unknown>>>("all", { sql: query, params })

    const runValues = (query: string, params: ReadonlyArray<unknown> = []) =>
      call<Array<unknown[]>>("values", { sql: query, params })

    const connection = identity<SqliteConnection>({
      execute(query, params, transformRows) {
        return transformRows ? Effect.map(run(query, params), transformRows) : run(query, params)
      },
      executeRaw(query, params) {
        return run(query, params)
      },
      executeValues(query, params) {
        return runValues(query, params)
      },
      executeUnprepared(query, params, transformRows) {
        return this.execute(query, params, transformRows)
      },
      executeStream() {
        return Stream.die("executeStream not implemented")
      },
      export: call<Uint8Array>("serialize"),
      loadExtension: () =>
        Effect.fail(
          new SqlError({
            reason: classifySqliteError(new Error("loadExtension is not supported by the worker backend"), {
              message: "Failed to load extension",
              operation: "loadExtension",
            }),
          }),
        ),
    })

    const semaphore = yield* Semaphore.make(1)
    const acquirer = semaphore.withPermits(1)(Effect.succeed(connection))
    const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
      const fiber = Fiber.getCurrent()!
      const scope = Context.getUnsafe(fiber.context, Scope.Scope)
      return Effect.as(
        Effect.tap(restore(semaphore.take(1)), () => Scope.addFinalizer(scope, semaphore.release(1))),
        connection,
      )
    })

    const client = Object.assign(
      (yield* Client.make({
        acquirer,
        compiler,
        transactionAcquirer,
        spanAttributes: [
          ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
          [ATTR_DB_SYSTEM_NAME, "sqlite"],
        ],
        transformRows,
      })) as SqliteClient,
      {
        [TypeId]: TypeId,
        config: options,
        export: Effect.flatMap(acquirer, (_) => _.export),
        loadExtension: (path: string) => Effect.flatMap(acquirer, (_) => _.loadExtension(path)),
      },
    )

    return { client, nativeLike }
  })

const makeClient = (options: Config) =>
  Effect.map(make(options), ({ client }) => client)

const nativeLayer = (config: Config) =>
  Layer.effect(
    Sqlite.Native,
    Effect.map(make(config), ({ nativeLike }) => nativeLike),
  )

const sqliteLayer = (config: Config) => Layer.effect(Client.SqlClient, makeClient(config))

// `Sqlite.Drizzle` has no production consumers outside the sync backends (drizzle only needs the
// raw native handle, which lives on the worker thread here). The service is simply not provided.
export const layer = (config: Config) =>
  Layer.merge(nativeLayer(config), sqliteLayer(config)).pipe(Layer.provide(Reactivity.layer))
