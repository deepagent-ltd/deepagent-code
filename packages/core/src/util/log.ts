export * as Log from "./log"

import path from "path"
import fs from "fs/promises"
import { createWriteStream } from "fs"
import * as Global from "../global"
import { Cause, Schema } from "effect"
import { Glob } from "./glob"

export const Level = Schema.Literals(["DEBUG", "INFO", "WARN", "ERROR"]).annotate({
  identifier: "LogLevel",
  description: "Log level",
})
export type Level = Schema.Schema.Type<typeof Level>

const levelPriority: Record<Level, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
}
const keep = 10
export const MAX_LOGGERS = 128
const initializedRunID = "DEEPAGENT_CODE_LOG_INITIALIZED_RUN_ID"

let level: Level = "INFO"

function shouldLog(input: Level): boolean {
  return levelPriority[input] >= levelPriority[level]
}

export type Logger = {
  debug(message?: any, extra?: Record<string, any>): void
  info(message?: any, extra?: Record<string, any>): void
  error(message?: any, extra?: Record<string, any>): void
  warn(message?: any, extra?: Record<string, any>): void
  tag(key: string, value: string): Logger
  clone(): Logger
  time(
    message: string,
    extra?: Record<string, any>,
  ): {
    stop(): void
    [Symbol.dispose](): void
  }
}

const loggers = new Map<string, Logger>()

export const Default = create({ service: "default" })

export interface Options {
  print: boolean
  dev?: boolean
  level?: Level
}

let logpath = ""
export function file() {
  return logpath
}
export function getLevel(): Level {
  return level
}
const writeStderr = (msg: any) => {
  process.stderr.write(msg)
  return msg.length
}
let write = writeStderr
let closeWrite: (() => Promise<void>) | undefined
let initialization = Promise.resolve()

export function init(options: Options) {
  const next = initialization.then(() => initialize(options))
  initialization = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

async function initialize(options: Options) {
  if (options.level) level = options.level
  // Route concurrent logs away from the previous stream before ending it. Test/runtime re-init can
  // overlap background fibers that log while the old file handle is closing.
  write = writeStderr
  await closeWrite?.()
  closeWrite = undefined
  logpath = ""
  void cleanup(Global.Path.log)
  if (options.print) return
  logpath = path.join(
    Global.Path.log,
    options.dev ? "dev.log" : new Date().toISOString().split(".")[0].replace(/:/g, "") + ".log",
  )
  const runID = process.env.DEEPAGENT_CODE_RUN_ID
  const shouldTruncate = !options.dev || !runID || process.env[initializedRunID] !== runID
  if (shouldTruncate) await fs.truncate(logpath).catch(() => {})
  if (options.dev && runID) process.env[initializedRunID] = runID
  const stream = createWriteStream(logpath, { flags: "a" })
  closeWrite = () => new Promise((resolve) => stream.end(resolve))
  write = async (msg: any) => {
    return new Promise((resolve, reject) => {
      stream.write(msg, (err) => {
        if (err) reject(err)
        else resolve(msg.length)
      })
    })
  }
}

async function cleanup(dir: string) {
  const files = (
    await Glob.scan("????-??-??T??????.log", {
      cwd: dir,
      absolute: false,
      include: "file",
    }).catch(() => [])
  )
    .filter((file) => path.basename(file) === file)
    .sort()
  if (files.length <= keep) return

  const doomed = files.slice(0, -keep)
  await Promise.all(doomed.map((file) => fs.unlink(path.join(dir, file)).catch(() => {})))
}

function formatError(error: Error, depth = 0): string {
  const result = error.message
  return error.cause instanceof Error && depth < 10
    ? result + " Caused by: " + formatError(error.cause, depth + 1)
    : result
}

// An Effect `Cause` carries a `toJSON` that serializes to `{"_id":"Cause",...,"defect":{}}` — the
// defect is dropped because an Error has no enumerable own properties. So a logger call like
// `log.error("share subscriber failed", { cause })` printed a cause with no cause, and the operator
// could see that something died but never why. Measured in an ablation container: 914 such lines in
// ten minutes, every one of them empty. `Cause.pretty` renders the defect, its message and its stack.
export function formatValue(value: object): string {
  return Cause.isCause(value) ? Cause.pretty(value) : JSON.stringify(value)
}

let last = Date.now()
export function create(tags?: Record<string, any>) {
  return createLogger(tags ?? {}, true)
}

function createLogger(tags: Record<string, any>, cache: boolean) {
  const service = tags["service"]
  const cacheable = cache && typeof service === "string" && Object.keys(tags).length === 1
  if (cacheable) {
    const cached = loggers.get(service)
    if (cached) {
      loggers.delete(service)
      loggers.set(service, cached)
      return cached
    }
  }

  function build(message: any, extra?: Record<string, any>) {
    const prefix = Object.entries({
      ...tags,
      ...extra,
    })
      .filter(([_, value]) => value !== undefined && value !== null)
      .map(([key, value]) => {
        const prefix = `${key}=`
        if (value instanceof Error) return prefix + formatError(value)
        if (typeof value === "object") return prefix + formatValue(value)
        return prefix + value
      })
      .join(" ")
    const next = new Date()
    const diff = next.getTime() - last
    last = next.getTime()
    return [next.toISOString().split(".")[0], "+" + diff + "ms", prefix, message].filter(Boolean).join(" ") + "\n"
  }
  const result: Logger = {
    debug(message?: any, extra?: Record<string, any>) {
      if (shouldLog("DEBUG")) {
        write("DEBUG " + build(message, extra))
      }
    },
    info(message?: any, extra?: Record<string, any>) {
      if (shouldLog("INFO")) {
        write("INFO  " + build(message, extra))
      }
    },
    error(message?: any, extra?: Record<string, any>) {
      if (shouldLog("ERROR")) {
        write("ERROR " + build(message, extra))
      }
    },
    warn(message?: any, extra?: Record<string, any>) {
      if (shouldLog("WARN")) {
        write("WARN  " + build(message, extra))
      }
    },
    tag(key: string, value: string) {
      return createLogger({ ...tags, [key]: value }, false)
    },
    clone() {
      return createLogger({ ...tags }, false)
    },
    time(message: string, extra?: Record<string, any>) {
      const now = Date.now()
      result.info(message, { status: "started", ...extra })
      function stop() {
        result.info(message, {
          status: "completed",
          duration: Date.now() - now,
          ...extra,
        })
      }
      return {
        stop,
        [Symbol.dispose]() {
          stop()
        },
      }
    },
  }

  if (cacheable) {
    if (loggers.size >= MAX_LOGGERS) loggers.delete(loggers.keys().next().value!)
    loggers.set(service, result)
  }

  return result
}
