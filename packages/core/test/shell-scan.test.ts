import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { ShellScan } from "@deepagent-code/core/shell/scan"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// The grammars parse in-process, so bash and PowerShell approval scans are pinned on any host;
// win32-only resolution details (cygpath, drive paths) are covered by the V1 shell tests on the
// windows-2025 CI runner. nameOf mirrors V1 Shell.name and is platform-dependent by contract, so
// the name matrix uses host-native spellings.
const it = testEffect(Layer.mergeAll(FSUtil.defaultLayer, CrossSpawnSpawner.defaultLayer))

const scan = Effect.fnUntraced(function* (
  command: string,
  opts: {
    cwd: string
    ps?: boolean
    shell?: string
    contains?: (candidate: string) => boolean
  },
) {
  const fs = yield* FSUtil.Service
  const spawner = yield* ChildProcessSpawner
  const io: ShellScan.IO = {
    lines: (next) => spawner.lines(next),
    isDir: (file) => fs.isDir(file),
  }
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const tree = yield* Effect.acquireRelease(ShellScan.parse(command, opts.ps ?? false), (tree) =>
        Effect.sync(() => tree.delete()),
      )
      return yield* ShellScan.collect(
        io,
        tree.rootNode,
        opts.cwd,
        opts.ps ?? false,
        opts.shell ?? (opts.ps ? "pwsh" : "bash"),
        opts.contains ?? (() => true),
      )
    }),
  )
})

describe("ShellScan names", () => {
  it.effect("maps shell names to dialects and flags", () =>
    Effect.sync(() => {
      expect(ShellScan.nameOf("/bin/bash")).toBe("bash")
      expect(ShellScan.nameOf("/usr/local/bin/pwsh")).toBe("pwsh")
      expect(ShellScan.isPosix("/bin/bash")).toBe(true)
      expect(ShellScan.isPosix("/bin/zsh")).toBe(true)
      expect(ShellScan.isPosix("/usr/local/bin/pwsh")).toBe(false)
      expect(ShellScan.isPs("/usr/local/bin/pwsh")).toBe(true)
      expect(ShellScan.isPs("/opt/powershell/powershell")).toBe(true)
      expect(ShellScan.isPs("/bin/bash")).toBe(false)
      if (process.platform === "win32") {
        expect(ShellScan.nameOf("C:/tools/PWSH.EXE")).toBe("pwsh")
        expect(ShellScan.nameOf("C:\\Windows\\System32\\cmd.exe")).toBe("cmd")
      }
    }),
  )

  // D-W2 strict default chain: pwsh → powershell → cmd (COMSPEC floor). Git Bash has no slot in
  // the default — it stays a configuration choice and a validation-dialect candidate.
  it.effect("defaultWindowsChain probes pwsh, then powershell, then COMSPEC/cmd, never Git Bash", () =>
    Effect.sync(() => {
      expect(ShellScan.defaultWindowsChain({})).toBe("cmd.exe")
      expect(ShellScan.defaultWindowsChain({ comspec: "C:\\Windows\\System32\\cmd.exe" })).toBe(
        "C:\\Windows\\System32\\cmd.exe",
      )
      expect(ShellScan.defaultWindowsChain({ powershell: "C:\\ps5\\powershell.exe" })).toBe("C:\\ps5\\powershell.exe")
      expect(ShellScan.defaultWindowsChain({ pwsh: "C:\\ps7\\pwsh.exe", powershell: "C:\\ps5\\powershell.exe" })).toBe(
        "C:\\ps7\\pwsh.exe",
      )
    }),
  )
})

describe("ShellScan collect (bash grammar)", () => {
  it.live("collects one pattern per command in a chain with arity prefixes", () =>
    Effect.gen(function* () {
      const result = yield* scan("echo foo && echo bar", { cwd: "/work" })
      expect([...result.patterns]).toEqual(["echo foo", "echo bar"])
      expect([...result.always]).toEqual(["echo *"])
      expect([...result.dirs]).toEqual([])
    }),
  )

  it.live("derives reusable prefixes from BashArity", () =>
    Effect.gen(function* () {
      const result = yield* scan("git log --oneline -5", { cwd: "/work" })
      expect([...result.patterns]).toEqual(["git log --oneline -5"])
      expect([...result.always]).toEqual(["git log *"])
    }),
  )

  it.live("keeps redirect targets in the permission pattern", () =>
    Effect.gen(function* () {
      const result = yield* scan("echo test > output.txt", { cwd: "/work" })
      expect([...result.patterns]).toEqual(["echo test > output.txt"])
    }),
  )

  it.live("skips bash approval for cd-only commands and keeps internal dirs unflagged", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const result = yield* scan("cd .", { cwd: tmp.path, contains: () => true })
          expect([...result.patterns]).toEqual([])
          expect([...result.always]).toEqual([])
          expect([...result.dirs]).toEqual([])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("flags file arguments outside the containment boundary", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        Effect.gen(function* () {
          const target = path.join(outside.path, "secret.txt")
          const result = yield* scan(`cat ${target}`, {
            cwd: active.path,
            contains: (candidate) => FSUtil.contains(active.path, candidate),
          })
          expect([...result.dirs]).toEqual([outside.path])
          expect([...result.patterns]).toEqual([`cat ${target}`])
          expect([...result.always]).toEqual(["cat *"])
        }),
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("ignores rm arguments inside the boundary", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const result = yield* scan(`rm -rf ${path.join(tmp.path, "nested")}`, {
            cwd: tmp.path,
            contains: (candidate) => FSUtil.contains(tmp.path, candidate),
          })
          expect([...result.dirs]).toEqual([])
          expect([...result.patterns]).toEqual([`rm -rf ${path.join(tmp.path, "nested")}`])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

describe("ShellScan collect (PowerShell grammar)", () => {
  it.live("splits PowerShell conditionals into per-command patterns", () =>
    Effect.gen(function* () {
      const result = yield* scan("Write-Host foo; if ($?) { Write-Host bar }", { cwd: "/work", ps: true })
      expect([...result.patterns]).toEqual(["Write-Host foo", "Write-Host bar"])
      expect([...result.always]).toEqual(["Write-Host *"])
    }),
  )

  it.live("resolves FileSystem provider paths behind cmdlet flags", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        Effect.gen(function* () {
          const target = path.join(outside.path, "win.ini").replaceAll("\\", "/")
          const result = yield* scan(`Get-Content -Path "FileSystem::${target}"`, {
            cwd: active.path,
            ps: true,
            contains: (candidate) => FSUtil.contains(active.path, candidate),
          })
          expect([...result.dirs]).toEqual([outside.path])
        }),
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )
})
