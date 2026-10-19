import { buffer } from "node:stream/consumers"
import path from "node:path"
import { Process } from "@/util/process"
import type { Codec } from "./dpapi"
import { Log } from "@deepagent-code/core/util/log"

const log = Log.create({ service: "mcp.dpapi" })

/**
 * Node implementation of the DPAPI codec for the desktop sidecar: powershell.exe
 * (Windows PowerShell 5.1) invoking .NET's System.Security.Cryptography.ProtectedData,
 * which calls the same win32 CryptProtectData/CryptUnprotectData the bun-side FFI codec
 * uses — so ciphertext blobs interop across the CLI and the sidecar. Selected under the
 * `node` import condition (the sidecar bundle must not contain bun:ffi). See dpapi.ts.
 *
 * Payloads travel as base64 over stdin/stdout so secrets never appear on the command
 * line (process table) and never hit size limits; each call is one powershell startup
 * (~hundreds of ms), acceptable for connect-time secret resolution.
 */

const PROTECT_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd()
$bytes = [Convert]::FromBase64String($in)
$out = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($out)`

const UNPROTECT_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd()
$bytes = [Convert]::FromBase64String($in)
$out = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($out)`

const runScript = async (script: string, stdinBase64: string) => {
  const started = performance.now()
  const operation = script === PROTECT_SCRIPT ? "protect" : "unprotect"
  const observed = { success: false }
  log.debug("MCP DPAPI phase", { stage: `${operation}.begin` })
  try {
    const executable = powershell()
    if (!executable) throw new Error("Windows PowerShell path is unavailable")
    const proc = Process.spawn([executable, "-NoProfile", "-NonInteractive", "-Command", script], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      abort: AbortSignal.timeout(10000),
    })
    if (!proc.stdin || !proc.stdout || !proc.stderr) throw new Error("powershell process pipes are unavailable")
    proc.stdin.end(stdinBase64)
    const [code, stdout, stderr] = await Promise.all([proc.exited, buffer(proc.stdout), buffer(proc.stderr)])
    if (code !== 0) throw new Error(`powershell ProtectedData failed (code ${code}): ${stderr.toString().trim()}`)
    observed.success = true
    return stdout.toString().trim()
  } finally {
    const fields = {
      stage: `${operation}.end`,
      success: observed.success,
      elapsedMs: Math.round(performance.now() - started),
    }
    if (!fields.success || fields.elapsedMs >= 1000) log.warn("MCP DPAPI phase", fields)
    log.debug("MCP DPAPI phase", fields)
  }
}

let probed: Promise<boolean> | undefined

export const dpapiCodec: Codec = {
  id: "powershell-protecteddata",
  available: async () => {
    const executable = powershell()
    if (!executable) return false
    // Cache the probe: powershell startup costs hundreds of ms and available() is
    // consulted on every backend selection.
    probed ??= Process.run(
      [executable, "-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Security; Write-Output ok"],
      { nothrow: true, abort: AbortSignal.timeout(10000) },
    )
      .catch(() => undefined)
      .then((res) => !!res && res.code === 0 && res.stdout.toString().includes("ok"))
    return probed
  },
  protect: async (plaintext) =>
    Buffer.from(await runScript(PROTECT_SCRIPT, Buffer.from(plaintext).toString("base64")), "base64"),
  unprotect: async (ciphertext) =>
    Buffer.from(await runScript(UNPROTECT_SCRIPT, Buffer.from(ciphertext).toString("base64")), "base64"),
}

function powershell() {
  const root = process.env.SystemRoot
  // Credential operations must not resolve a program from a project directory or PATH.
  if (process.platform !== "win32" || !root || !/^[A-Za-z]:[\\/]/.test(root) || /[\r\n\0<>"|?*]/.test(root) ||
    root.split(/[\\/]/).some((part) => part === "." || part === "..")) return undefined
  return path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}
