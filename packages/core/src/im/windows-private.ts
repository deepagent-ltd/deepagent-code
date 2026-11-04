export * as WindowsPrivate from "./windows-private"

import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"

const SCRIPT = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Import-Module -Name ($PSHOME+'/Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$count=1
if ($env:DAC_MEDIA_PRIVATE_COUNT) { $count=[int]$env:DAC_MEDIA_PRIVATE_COUNT }
for($index=0;$index -lt $count;$index++){
  $suffix=if($index -eq 0){''}else{"_$index"}
  $p=[Environment]::GetEnvironmentVariable("DAC_MEDIA_PRIVATE_PATH$suffix")
  $directory=[Environment]::GetEnvironmentVariable("DAC_MEDIA_PRIVATE_DIRECTORY$suffix") -eq '1'
  $create=[Environment]::GetEnvironmentVariable("DAC_MEDIA_PRIVATE_CREATE$suffix") -eq '1'
  $item=Get-Item -LiteralPath $p -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe' }
  if ($create) {
    $acl=[Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true,$false)
    foreach ($s in @($sid.Value,'S-1-5-18','S-1-5-32-544')) {
      $rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($s),[Security.AccessControl.FileSystemRights]::FullControl,([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
      $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $p -AclObject $acl
  }
  $acl=Get-Acl -LiteralPath $p
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'unsafe' }
  if ($directory -and -not $acl.AreAccessRulesProtected) { throw 'unsafe' }
  $rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
  if ($rules.Count -eq 0) { throw 'unsafe' }
  $own=$false
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Value -notin @($sid.Value,'S-1-5-18','S-1-5-32-544')) { throw 'unsafe' }
    if ($rule.IdentityReference.Value -eq $sid.Value -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $own=$true }
  }
  if (-not $own) { throw 'unsafe' }
}
`

export type Entry = { file: string; directory: boolean; created: boolean }

export function invocation(systemRoot: string, file: string, directory: boolean, created: boolean) {
  return entriesInvocation(systemRoot, [{ file, directory, created }])
}

export function entriesInvocation(systemRoot: string, entries: readonly Entry[]) {
  if (
    entries.length === 0 ||
    ![systemRoot, ...entries.map((entry) => entry.file)].every(
      (value) => path.win32.isAbsolute(value) && !value.includes("\0") && path.win32.parse(value).root.length > 1,
    ) ||
    entries.some((entry) => entry.created && !entry.directory)
  )
    throw new Error("unsafe")
  const env: Record<string, string> = { SystemRoot: systemRoot }
  entries.forEach((entry, index) => {
    const suffix = index === 0 ? "" : `_${index}`
    env[`DAC_MEDIA_PRIVATE_PATH${suffix}`] = entry.file
    env[`DAC_MEDIA_PRIVATE_DIRECTORY${suffix}`] = entry.directory ? "1" : "0"
    env[`DAC_MEDIA_PRIVATE_CREATE${suffix}`] = entry.created ? "1" : "0"
  })
  if (entries.length > 1) env.DAC_MEDIA_PRIVATE_COUNT = String(entries.length)
  return {
    cmd: [
      path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(SCRIPT, "utf16le").toString("base64"),
    ],
    env,
  }
}

export async function verify(entries: readonly Entry[]) {
  const invocation = entriesInvocation(process.env.SystemRoot ?? "", entries)
  const started = Date.now()
  const preferred = path.win32.join(
    path.win32.parse(invocation.cmd[0]).root,
    "Program Files",
    "PowerShell",
    "7",
    "pwsh.exe",
  )
  const executable = await fs
    .realpath(preferred)
    .then((candidate) =>
      path.win32.normalize(candidate).toLowerCase() === path.win32.normalize(preferred).toLowerCase()
        ? preferred
        : invocation.cmd[0],
    )
    .catch(() => invocation.cmd[0])
  const child = spawn(executable, invocation.cmd.slice(1), {
    env: invocation.env,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    shell: false,
  })
  const state = { closed: false, timedOut: false, spawnError: false }
  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4096)
  })
  const exited = new Promise<number | null>((resolve) => {
    child.once("error", () => {
      state.spawnError = true
      resolve(null)
    })
    child.once("close", (code) => {
      state.closed = true
      resolve(code)
    })
  })
  const deadline = setTimeout(() => {
    state.timedOut = true
    if (!state.closed) child.kill("SIGKILL")
  }, 45_000)
  const join = { timer: undefined as ReturnType<typeof setTimeout> | undefined }
  try {
    const code = await Promise.race([
      exited,
      new Promise<null>((resolve) => {
        join.timer = setTimeout(() => resolve(null), 47_000)
      }),
    ])
    if (!state.closed || state.timedOut || code !== 0) {
      const outcome = state.timedOut
        ? "timeout"
        : state.spawnError
          ? "spawn-error"
          : !state.closed
            ? "close-unknown"
            : "exit"
      const diagnostic = `${outcome}; executable=${path.win32.basename(executable)}; exitCode=${code}; elapsedMs=${Date.now() - started}`
      throw new Error(stderr.trim() ? `${diagnostic}; stderr=${stderr.trim()}` : diagnostic)
    }
  } finally {
    clearTimeout(deadline)
    clearTimeout(join.timer)
    if (!state.closed) child.kill("SIGKILL")
  }
}
