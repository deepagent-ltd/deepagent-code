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
              for (const entry of entries) {
                const current = await fs.lstat(entry.path, { bigint: true })
                if (!same(current, entry.stat)) throw new Error({ code: "changed" })
                await privateEntry(entry.path, current, true)
              }
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
      await privateEntry(file, stat, true, created)
      entries.push({ path: file, stat })
    }
    const check = () =>
      attempt(async () => {
        if ((await fs.realpath(Global.Path.data)) !== data || !same(await fs.lstat(data, { bigint: true }), dataStat))
          throw new Error({ code: "changed" })
        for (const entry of entries) {
          const current = await fs.lstat(entry.path, { bigint: true })
          if (!same(current, entry.stat)) throw new Error({ code: "changed" })
          await privateEntry(entry.path, current, true)
        }
      })
    await check()
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
$p=$env:DAC_MEDIA_PRIVATE_PATH
$item=Get-Item -LiteralPath $p -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe' }
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
if ($env:DAC_MEDIA_PRIVATE_CREATE -eq '1') {
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
if ($env:DAC_MEDIA_PRIVATE_DIRECTORY -eq '1' -and -not $acl.AreAccessRulesProtected) { throw 'unsafe' }
$rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
if ($rules.Count -eq 0) { throw 'unsafe' }
$own=$false
foreach ($rule in $rules) {
  if ($rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Value -notin @($sid.Value,'S-1-5-18','S-1-5-32-544')) { throw 'unsafe' }
  if ($rule.IdentityReference.Value -eq $sid.Value -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $own=$true }
}
if (-not $own) { throw 'unsafe' }
`

export function windowsPrivateInvocation(systemRoot: string, file: string, directory: boolean, created: boolean) {
  if (
    ![systemRoot, file].every(
      (value) => path.win32.isAbsolute(value) && !value.includes("\0") && path.win32.parse(value).root.length > 1,
    ) ||
    (created && !directory)
  )
    throw new Error({ code: "unsafe" })
  return {
    cmd: [
      path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(WINDOWS_PRIVATE_SCRIPT, "utf16le").toString("base64"),
    ],
    env: {
      SystemRoot: systemRoot,
      DAC_MEDIA_PRIVATE_PATH: file,
      DAC_MEDIA_PRIVATE_DIRECTORY: directory ? "1" : "0",
      DAC_MEDIA_PRIVATE_CREATE: created ? "1" : "0",
    },
  }
}

async function windowsPrivate(file: string, directory: boolean, created: boolean) {
  const invocation = windowsPrivateInvocation(process.env.SystemRoot ?? "", file, directory, created)
  const child = spawn(invocation.cmd[0], invocation.cmd.slice(1), {
    env: invocation.env,
    stdio: "ignore",
    windowsHide: true,
  })
  const exit = new Promise<boolean>((resolve) => {
    child.once("error", () => resolve(false))
    child.once("close", (code) => resolve(code === 0))
  })
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  }
  const timer = setTimeout(stop, 5000)
  try {
    if (!(await exit)) throw new Error({ code: "unsafe" })
  } finally {
    clearTimeout(timer)
    stop()
  }
}
