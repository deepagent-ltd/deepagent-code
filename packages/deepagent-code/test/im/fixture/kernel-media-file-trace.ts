export * as MediaFileTrace from "./kernel-media-file-trace"

import fs from "node:fs/promises"

/** A QA delegate around the original handles. It keeps the same FD, arguments,
 * resolved objects and errors; the only observations are fixed counters. */
export function install(prefix: string, emit?: (fact: { operation: string; phase: "start" | "settled" | "error"; handle?: number; bytesRead?: number }) => void) {
  const original = { open: fs.open, lstat: fs.lstat, realpath: fs.realpath }
  const facts: { operation: string; phase: "start" | "settled" | "error"; handle?: number; bytesRead?: number }[] = []
  const counts: Record<string, number> = {}
  const handles = { value: 0 }
  const record = (operation: string, phase: "start" | "settled" | "error", handle?: number, bytesRead?: number) => {
    counts[`${operation}:${phase}`] = (counts[`${operation}:${phase}`] ?? 0) + 1
    const fact = { operation, phase, ...(handle === undefined ? {} : { handle }), ...(bytesRead === undefined ? {} : { bytesRead }) }
    if (facts.length < 4096) facts.push(fact)
    // A diagnostic callback never changes the original filesystem operation.
    try { emit?.(fact) } catch {}
  }
  fs.open = (async (...input: Parameters<typeof fs.open>) => {
    if (typeof input[0] !== "string" || !input[0].startsWith(prefix)) return Reflect.apply(original.open, fs, input)
    const handle = ++handles.value
    record("open", "start", handle)
    const file = await Reflect.apply(original.open, fs, input).then((value: Awaited<ReturnType<typeof fs.open>>) => {
      record("open", "settled", handle)
      return value
    }, (error: unknown) => { record("open", "error", handle); throw error }) as Awaited<ReturnType<typeof fs.open>>
    const methods = { read: file.read, stat: file.stat, close: file.close }
    file.read = ((...args: Parameters<typeof file.read>) => {
      record("read", "start", handle)
      return (Reflect.apply(methods.read, file, args) as ReturnType<typeof file.read>).then((value) => {
        record("read", "settled", handle, value.bytesRead)
        return value
      }, (error: unknown) => { record("read", "error", handle); throw error })
    }) as typeof file.read
    file.stat = ((...args: Parameters<typeof file.stat>) => {
      record("stat", "start", handle)
      return (Reflect.apply(methods.stat, file, args) as ReturnType<typeof file.stat>).then((value) => {
        record("stat", "settled", handle)
        return value
      }, (error: unknown) => { record("stat", "error", handle); throw error })
    }) as typeof file.stat
    file.close = () => {
      record("close", "start", handle)
      return methods.close.call(file).then((value) => { record("close", "settled", handle); return value },
        (error: unknown) => { record("close", "error", handle); throw error })
    }
    return file
  }) as typeof fs.open
  fs.lstat = ((...input: Parameters<typeof fs.lstat>) => {
    const watched = typeof input[0] === "string" && input[0].startsWith(prefix)
    if (watched) record("lstat", "start")
    return (Reflect.apply(original.lstat, fs, input) as ReturnType<typeof fs.lstat>).then((value) => {
      if (watched) record("lstat", "settled")
      return value
    }, (error: unknown) => { if (watched) record("lstat", "error"); throw error })
  }) as typeof fs.lstat
  fs.realpath = ((...input: Parameters<typeof fs.realpath>) => {
    const watched = typeof input[0] === "string" && input[0].startsWith(prefix)
    if (watched) record("realpath", "start")
    return (Reflect.apply(original.realpath, fs, input) as ReturnType<typeof fs.realpath>).then((value) => {
      if (watched) record("realpath", "settled")
      return value
    }, (error: unknown) => { if (watched) record("realpath", "error"); throw error })
  }) as typeof fs.realpath
  return { facts, counts, restore() { fs.open = original.open; fs.lstat = original.lstat; fs.realpath = original.realpath } }
}
