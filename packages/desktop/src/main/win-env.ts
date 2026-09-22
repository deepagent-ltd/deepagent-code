// D-W3 (G3): Windows environment loading for the desktop main process.
//
// GUI apps on Windows inherit the environment of whatever launched them, which
// can be stale (session started before the user edited their env) or minimal
// (launched from the installer or a service). The registry is the durable
// source of truth — this module reads the user (HKCU\Environment) and system
// (HKLM\...\Session Manager\Environment) hives with a zero-dependency
// `reg query` call and fills any variable the process env is missing.
//
// Everything here is fail-open: any failure to run or parse `reg query` leaves
// process.env untouched — env loading must never block startup.

import { spawnSync } from "node:child_process"
import { join } from "node:path"

const REG_QUERY_TIMEOUT = 5_000

// %WINDIR% is expanded by the shell that launched us; when it is missing
// (service contexts) System32 lives on the system drive by convention.
function regExePath(env: Record<string, string | undefined>) {
  return join(env.windir ?? env.WINDIR ?? "C:\\Windows", "System32", "reg.exe")
}

export const USER_ENV_KEY = "HKCU\\Environment"
export const SYSTEM_ENV_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"

type WinEnvLogger = { log: (message: string) => void }

type RunRegQuery = (key: string) => { status: number | null; stdout: string; error?: Error }

function runRegQueryFactory(env: Record<string, string | undefined>): RunRegQuery {
  return (key) => {
    const out = spawnSync(regExePath(env), ["query", key], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: REG_QUERY_TIMEOUT,
      windowsHide: true,
      encoding: "utf8",
      env,
    })
    return { status: out.status, stdout: out.stdout ?? "", error: out.error }
  }
}

// Parses `reg query` output. Value lines look like:
//
//     NAME<2+ spaces>REG_SZ<2+ spaces>VALUE WITH SPACES
//
// The data column keeps internal spacing (trailing spaces matter for some
// values), so only the first two wide separators split the line. Types other
// than REG_SZ / REG_EXPAND_SZ (DWORD, BINARY, MULTI_SZ) cannot round-trip as
// process env strings and are skipped, as are wrapped continuation lines.
export function parseRegQueryOutput(output: string) {
  return output
    .split(/\r?\n/)
    .flatMap((line) => {
      if (!line.startsWith("    ")) return []
      const match = /^ +(.*?) {2,}(REG_[A-Z_]+) {2,}(.*)$/.exec(line)
      if (!match) return []
      const [, name, type, data] = match
      if (name === "(Default)" || name === "") return []
      if (type !== "REG_SZ" && type !== "REG_EXPAND_SZ") return []
      return [{ name, type, data }]
    })
}

// Expands %VAR% references in a REG_EXPAND_SZ value. Unknown references stay
// literal (fail-open — a half-expanded PATH is worse than the raw value).
// Expansion is iterative so chained references (%A% contains %B%, %B%
// contains %C%) resolve; the bound stops self-referential cycles.
export function expandRegValue(value: string, resolve: (name: string) => string | undefined, maxPasses = 8) {
  let current = value
  for (let pass = 0; pass < maxPasses; pass++) {
    const next = current.replace(/%([^%]+)%/g, (whole, name: string) => resolve(name) ?? whole)
    if (next === current) return current
    current = next
  }
  return current
}

function lookupTable(env: Record<string, string>) {
  const byUpper = new Map(Object.entries(env).map(([key, value]) => [key.toUpperCase(), value]))
  return (name: string) => byUpper.get(name.toUpperCase())
}

// Windows env names are case-insensitive: a registry value only contributes
// when the process env has no case-insensitive equivalent. PATH is the one
// composed value — when the process env lacks it entirely, the Windows
// composition order is system entries first, then user entries.
export function mergeRegistryEnv(
  processEnv: Record<string, string | undefined>,
  userEnv: Record<string, string>,
  systemEnv: Record<string, string>,
) {
  const has = (name: string) =>
    Object.keys(processEnv).some((existing) => existing.toUpperCase() === name.toUpperCase())

  const merged: Record<string, string> = {}
  for (const [name, value] of Object.entries(systemEnv)) {
    if (!has(name)) merged[name] = value
  }
  for (const [name, value] of Object.entries(userEnv)) {
    if (!has(name)) merged[name] = value
  }
  if (!has("PATH")) {
    const composed = [lookupTable(systemEnv)("PATH"), lookupTable(userEnv)("PATH")]
      .filter((part): part is string => Boolean(part))
      .join(";")
    if (composed) merged.PATH = composed
  }
  return merged
}

export type WindowsEnvOptions = {
  env?: Record<string, string | undefined>
  runRegQuery?: RunRegQuery
  logger?: WinEnvLogger
}

// Reads both registry hives and returns the variables to fill into
// process.env (already respecting process-env priority). Returns an empty
// object on any failure — never throws, never blocks startup.
export function loadWindowsEnv(options: WindowsEnvOptions = {}) {
  const env = options.env ?? process.env
  const runRegQuery = options.runRegQuery ?? runRegQueryFactory(env)

  const readHive = (key: string): Record<string, string> => {
    try {
      const out = runRegQuery(key)
      if (out.error || out.status !== 0) {
        options.logger?.log(`[server] reg query failed for ${key}: ${out.error?.message ?? `status ${out.status}`}`)
        return {}
      }
      return Object.fromEntries(parseRegQueryOutput(out.stdout).map((value) => [value.name, value.data]))
    } catch (error) {
      options.logger?.log(
        `[server] reg query threw for ${key}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return {}
    }
  }

  // The raw hives power %VAR% expansion: the live process env first (already
  // expanded by Windows), then raw user values, then raw system values, each
  // recursively expanded so chains through unexpanded hives resolve.
  const rawUser = readHive(USER_ENV_KEY)
  const rawSystem = readHive(SYSTEM_ENV_KEY)
  const liveEnv = Object.fromEntries(
    Object.entries(env).flatMap(([key, value]) => (value === undefined ? [] : [[key, value] as const])),
  )
  const live = lookupTable(liveEnv)
  const user = lookupTable(rawUser)
  const system = lookupTable(rawSystem)
  const resolveVar = (name: string): string | undefined => {
    if (live(name) !== undefined) return live(name)
    if (user(name) !== undefined) return expandRegValue(user(name)!, resolveVar)
    if (system(name) !== undefined) return expandRegValue(system(name)!, resolveVar)
    return undefined
  }

  const expanded = (raw: Record<string, string>) =>
    Object.fromEntries(Object.entries(raw).map(([name, data]) => [name, expandRegValue(data, resolveVar)]))

  return mergeRegistryEnv(env, expanded(rawUser), expanded(rawSystem))
}
