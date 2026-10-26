export * as DurablePublish from "./durable-publish"

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Data, Effect } from "effect"

export class PublishError extends Data.TaggedError("DurablePublish.PublishError")<{
  readonly detail: string
}> {}

// Early database migration runs before AppRoot/native-profile authority exists. This fixed OS
// bridge is independent of that authority. Windows/NTFS uses a held file handle, explicit file
// flushes and MoveFileExW(MOVEFILE_WRITE_THROUGH), never a skipped directory fsync. These are
// Win32 synchronous API guarantees, not a claim that a physical power-loss test was performed.
// https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw
// https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew#caching-behavior
const script = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
try {
  if($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage'){throw 'unsupported_language_mode'}
  $inputValue=[Console]::In.ReadToEnd() | ConvertFrom-Json
  if($inputValue.protocol -ne 1 -or $inputValue.nonce -notmatch '^[0-9a-f-]{36}$' -or $inputValue.replace -isnot [bool]){throw 'invalid_request'}
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.ComponentModel;
using System.Text;
using System.Runtime.InteropServices;
public static class DacDurablePublish {
  [StructLayout(LayoutKind.Sequential)] public struct Info {
    public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr handle, out Info info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushFileBuffers(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool MoveFileExW(string source, string target, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetVolumeInformationByHandleW(IntPtr handle, IntPtr name, uint nameSize, out uint serial, out uint component, out uint flags, StringBuilder fileSystem, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  static IntPtr Open(string name, uint access, uint flags) {
    IntPtr handle=CreateFileW(name,access,7,IntPtr.Zero,3,flags,IntPtr.Zero);
    if(handle==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    return handle;
  }
  static Info Read(IntPtr handle, bool directory) {
    Info info; if(!GetFileInformationByHandle(handle,out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
    if((info.Attributes & 0x400)!=0 || ((info.Attributes & 0x10)!=0)!=directory) throw new InvalidOperationException("invalid_file_type");
    return info;
  }
  public static string Publish(string source, string target, bool replace) {
    source=Path.GetFullPath(source);target=Path.GetFullPath(target);
    if(!String.Equals(Path.GetDirectoryName(source),Path.GetDirectoryName(target),StringComparison.OrdinalIgnoreCase) || String.Equals(source,target,StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("not_adjacent");
    IntPtr parent=IntPtr.Zero, held=IntPtr.Zero, final=IntPtr.Zero;
    try {
      parent=Open(Path.GetDirectoryName(target),0x80000000,0x02200000);
      held=Open(source,0xC0000000,0x80200000);
      Info before=Read(held,false);Info dir=Read(parent,true);
      uint serial, component, flags;var fileSystem=new StringBuilder(32);
      if(!GetVolumeInformationByHandleW(held,IntPtr.Zero,0,out serial,out component,out flags,fileSystem,32)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if(fileSystem.ToString()!="NTFS") throw new InvalidOperationException("unsupported_file_system");
      if(before.Volume!=dir.Volume) throw new InvalidOperationException("different_volume");
      if(!FlushFileBuffers(held)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if(!MoveFileExW(source,target,replace ? 9u : 8u)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if(!FlushFileBuffers(held)) throw new Win32Exception(Marshal.GetLastWin32Error());
      final=Open(target,0x80000000,0x00200000);
      Info after=Read(final,false);
      if(before.Volume!=after.Volume || before.IndexHigh!=after.IndexHigh || before.IndexLow!=after.IndexLow) throw new InvalidOperationException("identity_changed");
      return before.Volume.ToString("x8")+":"+before.IndexHigh.ToString("x8")+before.IndexLow.ToString("x8");
    } finally {
      int error=0;
      foreach(IntPtr handle in new IntPtr[]{final,held,parent}) if(handle!=IntPtr.Zero && !CloseHandle(handle) && error==0) error=Marshal.GetLastWin32Error();
      if(error!=0) throw new Win32Exception(error);
    }
  }
}
'@
  $identity=[DacDurablePublish]::Publish([string]$inputValue.source,[string]$inputValue.target,$inputValue.replace)
  @{protocol=1;nonce=$inputValue.nonce;identity=$identity} | ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine('windows_durable_publish_failed')
  exit 1
}
`

const failure = () =>
  new PublishError({
    detail: "Windows durable publication failed or its outcome is unknown; inspect the files before retrying",
  })

export const windows = (source: string, target: string, replace: boolean) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: async () => {
        // Do not resolve a privileged OS executable through PATH or a caller-supplied script.
        const system = "C:\\Windows\\System32"
        const executable = path.win32.join(system, "WindowsPowerShell", "v1.0", "powershell.exe")
        const terminator = path.win32.join(system, "taskkill.exe")
        if (
          process.platform !== "win32" ||
          path.win32.normalize(process.env.SystemRoot ?? "").toLowerCase() !== "c:\\windows"
        )
          throw failure()
        for (const file of [executable, terminator]) {
          if (!(await fs.lstat(file)).isFile() || (await fs.realpath(file)).toLowerCase() !== file.toLowerCase())
            throw failure()
        }
        if (!path.isAbsolute(source) || !path.isAbsolute(target) || source.length + target.length > 32_000)
          throw failure()
        const nonce = randomUUID()
        const child = spawn(
          executable,
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
          ],
          {
            shell: false,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
          },
        )
        const state = { exited: false, invalid: false, output: "", stopping: undefined as Promise<void> | undefined }
        const joined = new Promise<number | null>((resolve) => {
          child.once("error", () => {
            state.invalid = true
          })
          child.once("close", (code) => {
            state.exited = true
            resolve(code)
          })
        })
        const stop = () =>
          (state.stopping ??= (async () => {
            if (state.exited) return
            // Add-Type can own a compiler child. Kill the whole owned process tree, then join the
            // PowerShell process before an interrupted restore can roll back or release its lease.
            const killer = spawn(terminator, ["/PID", String(child.pid), "/T", "/F"], {
              shell: false,
              windowsHide: true,
              stdio: "ignore",
            })
            const timer = setTimeout(() => killer.kill(), 5_000)
            await new Promise<void>((resolve) => {
              killer.once("error", () => {
                state.invalid = true
              })
              killer.once("close", () => resolve())
            }).finally(() => clearTimeout(timer))
            if (!state.exited) child.kill()
            await joined
          })())
        const timer = setTimeout(() => {
          state.invalid = true
          void stop()
        }, 30_000)
        child.stdout.setEncoding("utf8")
        child.stdout.on("data", (chunk: string) => {
          state.output += chunk
          if (state.output.length <= 4_096) return
          state.invalid = true
          state.output = ""
          void stop()
        })
        child.stderr.on("data", () => {
          /* Diagnostics contain no caller data and are not a receipt. */
        })
        child.stdin.on("error", () => {
          state.invalid = true
        })
        child.stdin.end(JSON.stringify({ protocol: 1, nonce, source, target, replace }))
        return { state, nonce, joined, stop, timer }
      },
      catch: failure,
    }),
    (owner) =>
      Effect.tryPromise({
        try: async () => {
          const code = await owner.joined
          if (code !== 0 || owner.state.invalid) throw failure()
          const receipt: unknown = JSON.parse(owner.state.output)
          if (
            !receipt ||
            typeof receipt !== "object" ||
            !("protocol" in receipt) ||
            receipt.protocol !== 1 ||
            !("nonce" in receipt) ||
            receipt.nonce !== owner.nonce ||
            !("identity" in receipt) ||
            typeof receipt.identity !== "string" ||
            !/^[0-9a-f]{8}:[0-9a-f]{16}$/.test(receipt.identity) ||
            Object.keys(receipt).length !== 3
          )
            throw failure()
        },
        catch: failure,
      }),
    (owner) =>
      Effect.promise(async () => {
        clearTimeout(owner.timer)
        await owner.stop()
      }),
  )
