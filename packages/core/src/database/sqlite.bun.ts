import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
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
import { layer as workerLayer } from "./sqlite.worker"

const ATTR_DB_SYSTEM_NAME = "db.system.name"

const TypeId = "~@deepagent-code/core/database/SqliteBun" as const
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

const make = (options: Config) =>
  Effect.gen(function* () {
    const native = (yield* Sqlite.Native) as Database

    const compiler = Statement.makeCompilerSqlite(options.transformQueryNames)
    const transformRows = options.transformResultNames
      ? Statement.defaultTransforms(options.transformResultNames).array
      : undefined

    // DEEPAGENT_CODE_PERF_DEBUG: log statements that block the event loop (sync sqlite hides
    // fsync + lock waits inside this call), plus the observed event-loop lag around them. This is
    // the instrument that distinguishes "slow DB" from "slow model" from "slow network".
    const perfDebug = process.env["DEEPAGENT_CODE_PERF_DEBUG"] === "1"
    const sqlSlowMs = Number(process.env["DEEPAGENT_CODE_PERF_SQL_MS"] ?? 25)
    // Statement histogram: the per-statement cost is dominated by prepare+values volume, so count
    // statements by their leading SQL shape and report the busiest every 2000 executions.
    const sqlCounts = new Map<string, number>()
    let sqlTotal = 0
    const sqlKey = (sql: string) => sql.replace(/\s+/g, " ").trim().slice(0, 60)
    const timed = <A>(sql: string, run: () => A): A => {
      if (!perfDebug) return run()
      const t0 = performance.now()
      try {
        return run()
      } finally {
        const ms = performance.now() - t0
        if (ms >= sqlSlowMs) console.error(`[perf] sqlite ${ms.toFixed(0)}ms: ${sql.slice(0, 140).replace(/\s+/g, " ")}`)
        const key = sqlKey(sql)
        sqlCounts.set(key, (sqlCounts.get(key) ?? 0) + 1)
        if (++sqlTotal % 2000 === 0) {
          const top = [...sqlCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
          console.error(`[perf] sql hist total=${sqlTotal}: ${JSON.stringify(top)}`)
        }
      }
    }

    const run = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<Array<Record<string, unknown>>, SqlError>((fiber) => {
        const statement = native.query(query)
        // @ts-ignore bun-types missing safeIntegers method, fixed in https://github.com/oven-sh/bun/pull/26627
        statement.safeIntegers(Context.get(fiber.context, Client.SafeIntegers))
        try {
          return Effect.succeed(timed(query, () => (statement.all(...(params as any)) ?? []) as Array<Record<string, unknown>>))
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
            }),
          )
        }
      })

    const runValues = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<Array<unknown[]>, SqlError>((fiber) => {
        const statement = native.query(query)
        // @ts-ignore bun-types missing safeIntegers method, fixed in https://github.com/oven-sh/bun/pull/26627
        statement.safeIntegers(Context.get(fiber.context, Client.SafeIntegers))
        try {
          return Effect.succeed(timed(query, () => (statement.values(...(params as any)) ?? []) as Array<unknown[]>))
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
            }),
          )
        }
      })

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
      export: Effect.try({
        try: () => native.serialize(),
        catch: (cause) =>
          new SqlError({
            reason: classifySqliteError(cause, { message: "Failed to export database", operation: "export" }),
          }),
      }),
      loadExtension: (path) =>
        Effect.try({
          try: () => native.loadExtension(path),
          catch: (cause) =>
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to load extension", operation: "loadExtension" }),
            }),
        }),
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

    return client
  })

const nativeLayer = (config: Config) =>
  Layer.effect(
    Sqlite.Native,
    Effect.gen(function* () {
      const native = new Database(config.filename, {
        readonly: config.readonly,
        readwrite: config.readwrite ?? true,
        create: config.create ?? true,
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => native.close()))
      if (config.disableWAL !== true) native.run("PRAGMA journal_mode = WAL;")
      return native
    }),
  )

const sqliteLayer = (config: Config) => Layer.effect(Client.SqlClient, make(config))

const drizzleLayer = Layer.effect(
  Sqlite.Drizzle,
  Effect.gen(function* () {
    return drizzle({ client: (yield* Sqlite.Native) as Database })
  }),
)

// Event-loop lag monitor (DEEPAGENT_CODE_PERF_DEBUG=1): a 1s timer that reports its own delay.
// Sync SQLite calls, heavy JSON work, or a non-yielding fiber all show up here as lag spikes; the
// corollary slow-sql log above then says whether the DB was the cause.
if (process.env["DEEPAGENT_CODE_PERF_DEBUG"] === "1") {
  // Sampling profiler: when the event-loop lags, dump the hottest JS frames so the blocking
  // function is named instead of inferred.
  void import("bun:jsc")
    .then((jsc) => {
      const api = jsc as unknown as {
        startSamplingProfiler?: () => void
        samplingProfilerStackTraces?: () => { traces?: { frames?: { name?: string; sourceURL?: string; line?: number }[] }[] }
      }
      api.startSamplingProfiler?.()
      let expected = Date.now() + 1000
      const timer = setInterval(() => {
        const now = Date.now()
        const lag = now - expected
        expected = now + 1000
        if (lag < 1000) return
        console.error(`[perf] event-loop lag ${lag}ms`)
        try {
          const traces = api.samplingProfilerStackTraces?.()?.traces ?? []
          // Aggregate the OUTERMOST application frames too: the innermost frame names the leaf
          // (e.g. JSON.stringify), but only the call stack says WHO invokes it in a loop.
          const innermost = new Map<string, number>()
          const stacks = new Map<string, number>()
          for (const trace of traces) {
            const frames = trace.frames ?? []
            if (frames.length === 0) continue
            const leaf = frames[0]
            innermost.set(
              `${leaf.name ?? "?"}@${(leaf.sourceURL ?? "").split("/").pop()}:${leaf.line ?? 0}`,
              (innermost.get(`${leaf.name ?? "?"}@${(leaf.sourceURL ?? "").split("/").pop()}:${leaf.line ?? 0}`) ?? 0) + 1,
            )
            // Application frames only (drop runtime builtins like (program)/(anonymous)).
            const app = frames
              .filter((f) => (f.name ?? "").length > 1 && (f.name ?? "") !== "(program)")
              .slice(0, 6)
              .map((f) => `${f.name}@${(f.sourceURL ?? "").split("/").pop()}:${f.line ?? 0}`)
            const key = app.join(" < ")
            if (key) stacks.set(key, (stacks.get(key) ?? 0) + 1)
          }
          const topIn = [...innermost.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
          const topStacks = [...stacks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
          console.error(`[perf] leaf(${traces.length}): ${JSON.stringify(topIn)}`)
          console.error(`[perf] stacks: ${JSON.stringify(topStacks)}`)
        } catch (error) {
          console.error(`[perf] profiler error: ${String(error)}`)
        }
      }, 1000)
      timer.unref?.()
    })
    .catch(() => {})
}

export const layer = (config: Config) => {
  // Opt-in worker backend: the synchronous backend couples SQLite fsync latency directly to the
  // event loop — on slow filesystems (synchronous=FULL) long provider turns starve every timer on
  // the loop for minutes (measured: 185s heartbeat gap). DEEPAGENT_CODE_DB_WORKER=1 selects the
  // worker-backed client; it is not yet the default while the drain-fiber scheduling interaction
  // with async statements is being validated.
  if (process.env["DEEPAGENT_CODE_DB_WORKER"] === "1") return workerLayer(config)
  const native = nativeLayer(config)
  return Layer.merge(native, Layer.merge(sqliteLayer(config), drizzleLayer).pipe(Layer.provide(native))).pipe(
    Layer.provide(Reactivity.layer),
  )
}
