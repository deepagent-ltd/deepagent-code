export * as MediaFiles from "./media-files"

import fs from "node:fs/promises"
import { constants, type BigIntStats } from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { Global } from "@deepagent-code/core/global"
import { AttachmentStorage } from "@deepagent-code/core/im/attachment-storage"
import type { IMAttachment } from "@deepagent-code/core/im/repository"

export class Error extends Schema.TaggedErrorClass<Error>()("IMMediaFileError", {
  code: Schema.Literals(["unsafe", "changed", "io", "cleanup"]),
  detail: Schema.optional(Schema.String),
}) {
  override get message() {
    return `Private media storage ${this.code}`
  }
}

const same = (left: BigIntStats, right: BigIntStats) => left.dev === right.dev && left.ino === right.ino
const sameFile = (left: BigIntStats, right: BigIntStats) =>
  same(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
const attempt = <A>(operation: () => Promise<A>) =>
  operation().catch((error: unknown) => {
    throw error instanceof Error ? error : new Error({ code: "io" })
  })
const absent = (error: unknown) =>
  error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT"

async function privateEntry(file: string, stat: BigIntStats, directory: boolean, created = false) {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error({ code: "unsafe" })
  if (process.platform === "win32") {
    await windowsPrivate(file, directory, created)
    return
  }
  if (
    !process.getuid ||
    stat.uid !== BigInt(process.getuid()) ||
    (stat.mode & 0o077n) !== 0n ||
    (!directory && stat.nlink !== 1n)
  )
    throw new Error({ code: "unsafe" })
}

export async function directory(workspaceID: string, create = false, allowMissing = false) {
  return attempt(async () => {
    const data = await fs.realpath(Global.Path.data)
    const root = path.join(data, "im-attachments")
    const workspace = path.join(root, AttachmentStorage.sanitizeSegment(workspaceID))
    const dataStat = await fs.lstat(data, { bigint: true })
    if (
      !dataStat.isDirectory() ||
      (process.platform !== "win32" &&
        (!process.getuid || dataStat.uid !== BigInt(process.getuid()) || (dataStat.mode & 0o022n) !== 0n))
    )
      throw new Error({ code: "unsafe" })
    const entries = [] as { path: string; stat: BigIntStats }[]
    const checkEntries = async () => {
      if (process.platform !== "win32") {
        for (const entry of entries) {
          const current = await fs.lstat(entry.path, { bigint: true })
          if (!same(current, entry.stat)) throw new Error({ code: "changed" })
          await privateEntry(entry.path, current, true)
        }
        return
      }
      const current = [] as { file: string; stat: BigIntStats }[]
      for (const entry of entries) {
        const stat = await fs.lstat(entry.path, { bigint: true })
        if (!same(stat, entry.stat)) throw new Error({ code: "changed" })
        current.push({ file: entry.path, stat })
      }
      if (current.length > 0)
        await windowsPrivateEntries(current.map((entry) => ({ file: entry.file, directory: true, created: false })))
    }
    for (const file of [root, workspace]) {
      const created = create
        ? await fs.mkdir(file, { mode: 0o700 }).then(
            () => true,
            (error: unknown) => {
              if (error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST")
                return false
              throw error
            },
          )
        : false
      const stat = await fs.lstat(file, { bigint: true }).catch((error: unknown) => {
        if (allowMissing && absent(error)) return undefined
        throw error
      })
      if (!stat)
        return {
          path: workspace,
          missing: true,
          check: () =>
            attempt(async () => {
              if (
                (await fs.realpath(Global.Path.data)) !== data ||
                !same(await fs.lstat(data, { bigint: true }), dataStat)
              )
                throw new Error({ code: "changed" })
              await checkEntries()
              if (
                await fs.lstat(file).then(
                  () => true,
                  (error: unknown) => {
                    if (absent(error)) return false
                    throw error
                  },
                )
              )
                throw new Error({ code: "changed" })
            }),
        }
      if (process.platform === "win32" && entries.length > 0) {
        await windowsPrivateEntries([
          { file, directory: true, created },
          ...entries.map((entry) => ({ file: entry.path, directory: true, created: false })),
          { file, directory: true, created: false },
        ])
      } else {
        await privateEntry(file, stat, true, created)
      }
      entries.push({ path: file, stat })
    }
    const check = () =>
      attempt(async () => {
        if ((await fs.realpath(Global.Path.data)) !== data || !same(await fs.lstat(data, { bigint: true }), dataStat))
          throw new Error({ code: "changed" })
        await checkEntries()
      })
    if (process.platform !== "win32") await check()
    return { path: workspace, check, missing: false }
  })
}

export async function open(value: IMAttachment) {
  const derived = AttachmentStorage.deriveStoragePath({
    dataDir: Global.Path.data,
    workspaceID: value.workspaceID,
    attachmentID: value.id,
  })
  if (
    !derived.ok ||
    derived.storagePath !== value.storagePath ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 0 ||
    value.sizeBytes > AttachmentStorage.maxAttachmentBytes()
  )
    throw new Error({ code: "unsafe" })
  return attempt(async () => {
    const parent = await directory(value.workspaceID)
    const target = path.join(parent.path, path.basename(derived.storagePath))
    const expected = await fs.lstat(target, { bigint: true })
    await privateEntry(target, expected, false)
    if (expected.size !== BigInt(value.sizeBytes)) throw new Error({ code: "changed" })
    const file = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = await file.stat({ bigint: true })
      if (!sameFile(expected, opened)) throw new Error({ code: "changed" })
      const check = () =>
        attempt(async () => {
          await parent.check()
          const current = await fs.lstat(target, { bigint: true })
          if (!sameFile(opened, await file.stat({ bigint: true })) || !sameFile(opened, current))
            throw new Error({ code: "changed" })
          await privateEntry(target, current, false)
        })
      await check()
      return { file, check, identity: opened, path: target, parent }
    } catch (error) {
      await file.close()
      throw error
    }
  })
}

export async function write(
  value: IMAttachment,
  copy: (file: Awaited<ReturnType<typeof fs.open>>) => Promise<void>,
  signal?: AbortSignal,
) {
  const derived = AttachmentStorage.deriveStoragePath({
    dataDir: Global.Path.data,
    workspaceID: value.workspaceID,
    attachmentID: value.id,
  })
  if (!derived.ok || derived.storagePath !== value.storagePath) throw new Error({ code: "unsafe" })
  return attempt(async () => {
    const parent = await directory(value.workspaceID, true)
    const target = path.join(parent.path, path.basename(derived.storagePath))
    await parent.check()
    const file = await fs.open(
      target,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    const captured = { identity: undefined as BigIntStats | undefined }
    try {
      const identity = await file.stat({ bigint: true })
      captured.identity = identity
      await privateEntry(target, identity, false)
      if (signal?.aborted) throw new Error({ code: "changed" })
      await copy(file)
      if (signal?.aborted) throw new Error({ code: "changed" })
      await file.sync()
      const digest = createHash("sha256")
      const buffer = Buffer.alloc(262144)
      for (let offset = 0; offset < value.sizeBytes; ) {
        if (signal?.aborted) throw new Error({ code: "changed" })
        const part = await file.read(buffer, 0, Math.min(buffer.length, value.sizeBytes - offset), offset)
        if (!part.bytesRead) throw new Error({ code: "changed" })
        digest.update(buffer.subarray(0, part.bytesRead))
        offset += part.bytesRead
      }
      await parent.check()
      if (signal?.aborted) throw new Error({ code: "changed" })
      const current = await fs.lstat(target, { bigint: true })
      const written = await file.stat({ bigint: true })
      if (
        !same(identity, current) ||
        !sameFile(current, written) ||
        written.size !== BigInt(value.sizeBytes) ||
        digest.digest("hex") !== value.checksum
      )
        throw new Error({ code: "changed" })
      await privateEntry(target, current, false)
    } catch (error) {
      // Only this O_EXCL-created inode is eligible for failed-copy cleanup. An
      // existing/replacement path remains untouched and its SQL reserve stays held.
      const removed = await parent
        .check()
        .then(async () => {
          const current = await fs.lstat(target, { bigint: true })
          if (
            !captured.identity ||
            !same(current, captured.identity) ||
            !same(captured.identity, await file.stat({ bigint: true }))
          )
            throw new Error({ code: "changed" })
          await fs.unlink(target)
        })
        .then(
          () => true,
          () => false,
        )
      throw removed ? error : new Error({ code: "cleanup" })
    } finally {
      await file.close()
    }
  })
}

// The caller holds the SQL cleanup owner. Refuse aliases, legacy guessed names,
// unsafe roots and replacement identities; a cursor never grants deletion.
export async function remove(value: IMAttachment) {
  const derived = AttachmentStorage.deriveStoragePath({
    dataDir: Global.Path.data,
    workspaceID: value.workspaceID,
    attachmentID: value.id,
  })
  if (!derived.ok || derived.storagePath !== value.storagePath) throw new Error({ code: "unsafe" })
  return attempt(async () => {
    const parent = await directory(value.workspaceID, false, true)
    if (parent.missing) {
      await parent.check()
      return
    }
    const target = path.join(parent.path, path.basename(derived.storagePath))
    const identity = await fs.lstat(target, { bigint: true }).catch((error: unknown) => {
      if (absent(error)) return undefined
      throw error
    })
    if (!identity) {
      await parent.check()
      return
    }
    await privateEntry(target, identity, false)
    const opened = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      await parent.check()
      if (
        !sameFile(identity, await opened.stat({ bigint: true })) ||
        !sameFile(identity, await fs.lstat(target, { bigint: true }))
      )
        throw new Error({ code: "changed" })
      await fs.unlink(target)
      await parent.check()
      // A same-path successor must not be reported as removed or release its reservation.
      if (
        await fs.lstat(target).then(
          () => true,
          (error: unknown) => {
            if (absent(error)) return false
            throw error
          },
        )
      )
        throw new Error({ code: "changed" })
    } finally {
      await opened.close()
    }
  })
}

const WINDOWS_PRIVATE_SCRIPT = `
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

type WindowsPrivateEntry = { file: string; directory: boolean; created: boolean }

export function windowsPrivateInvocation(systemRoot: string, file: string, directory: boolean, created: boolean) {
  return windowsPrivateEntriesInvocation(systemRoot, [{ file, directory, created }])
}

function windowsPrivateEntriesInvocation(systemRoot: string, entries: readonly WindowsPrivateEntry[]) {
  if (
    entries.length === 0 ||
    ![systemRoot, ...entries.map((entry) => entry.file)].every(
      (value) => path.win32.isAbsolute(value) && !value.includes("\0") && path.win32.parse(value).root.length > 1,
    ) ||
    entries.some((entry) => entry.created && !entry.directory)
  )
    throw new Error({ code: "unsafe" })
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
      Buffer.from(WINDOWS_PRIVATE_SCRIPT, "utf16le").toString("base64"),
    ],
    env,
  }
}

async function windowsPrivateEntries(entries: readonly WindowsPrivateEntry[]) {
  const invocation = windowsPrivateEntriesInvocation(process.env.SystemRoot ?? "", entries)
  const started = Date.now()
  const preferred = path.win32.join(path.win32.parse(invocation.cmd[0]).root, "Program Files", "PowerShell", "7", "pwsh.exe")
  const executable = await fs.realpath(preferred).then(
    (candidate) => path.win32.normalize(candidate).toLowerCase() === path.win32.normalize(preferred).toLowerCase()
      ? preferred
      : invocation.cmd[0],
  ).catch(() => invocation.cmd[0])
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
      const outcome = state.timedOut ? "timeout" : state.spawnError ? "spawn-error" : !state.closed ? "close-unknown" : "exit"
      const diagnostic = `${outcome}; executable=${path.win32.basename(executable)}; exitCode=${code}; elapsedMs=${Date.now() - started}`
      throw new Error({ code: "unsafe", detail: stderr.trim() ? `${diagnostic}; stderr=${stderr.trim()}` : diagnostic })
    }
  } finally {
    clearTimeout(deadline)
    clearTimeout(join.timer)
    if (!state.closed) child.kill("SIGKILL")
  }
}

async function windowsPrivate(file: string, directory: boolean, created: boolean) {
  return windowsPrivateEntries([{ file, directory, created }])
}
