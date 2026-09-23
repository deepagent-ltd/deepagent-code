import { buffer } from "node:stream/consumers"
import { Process } from "@/util/process"
import type { Codec } from "./dpapi"

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
$out = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataScope]::CurrentUser)
[Convert]::ToBase64String($out)`

const UNPROTECT_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd()
$bytes = [Convert]::FromBase64String($in)
$out = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataScope]::CurrentUser)
[Convert]::ToBase64String($out)`

const runScript = async (script: string, stdinBase64: string) => {
  const proc = Process.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!proc.stdin || !proc.stdout || !proc.stderr) throw new Error("powershell process pipes are unavailable")
  proc.stdin.end(stdinBase64)
  const [code, stdout, stderr] = await Promise.all([proc.exited, buffer(proc.stdout), buffer(proc.stderr)])
  if (code !== 0) throw new Error(`powershell ProtectedData failed (code ${code}): ${stderr.toString().trim()}`)
  return stdout.toString().trim()
}

let probed: Promise<boolean> | undefined

export const dpapiCodec: Codec = {
  id: "powershell-protecteddata",
  available: async () => {
    if (process.platform !== "win32") return false
    // Cache the probe: powershell startup costs hundreds of ms and available() is
    // consulted on every backend selection.
    probed ??= Process.run(
      ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Security; Write-Output ok"],
      { nothrow: true },
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
