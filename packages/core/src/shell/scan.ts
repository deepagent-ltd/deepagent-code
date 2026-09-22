export * as ShellScan from "./scan"

import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { Effect, Schema } from "effect"
import { Language, type Node } from "web-tree-sitter"
import { ChildProcess } from "effect/unstable/process"
import { FSUtil } from "../fs-util"
import { Log } from "../util/log"
import { lazy } from "../util/lazy"
import { BashArity } from "./arity"

// Shared shell-command approval scan (D-W2): the tree-sitter bash/PowerShell dual-grammar parse,
// per-command permission patterns, BashArity prefix approvals, and cmd/PowerShell path handling
// lifted out of the V1 ShellTool so V1 and the V2 core bash tool run the same logic. Host probes
// (process spawning for cygpath, directory checks) are passed in explicitly as IO so the module
// stays Location/runtime agnostic; containment is the caller's security boundary.

const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])
const POSIX_NAMES = new Set(["bash", "dash", "ksh", "sh", "zsh"])

export type Part = {
  type: string
  text: string
}

export type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

export type IO = {
  // lines may fail with anything; cygpath catches it internally. isDir must be error-free so the
  // scan keeps a `never` error channel and tool executors stay defect-only (V1 contract).
  readonly lines: (command: ChildProcess.Command) => Effect.Effect<readonly string[], unknown>
  readonly isDir: (path: string) => Effect.Effect<boolean>
}

export class ParseError extends Schema.TaggedErrorClass<ParseError>()("ShellScanParseError", {
  command: Schema.String,
}) {}

const log = Log.create({ service: "shell-scan" })

// Host-aware shell name normalization, mirroring the V1 Shell.name contract (win32 parses the
// windows spelling of the path; posix uses basename) so dialect/kind decisions agree across V1/V2.
export function nameOf(file: string) {
  if (process.platform === "win32") return path.win32.parse(FSUtil.windowsPath(file)).name.toLowerCase()
  return path.basename(file).toLowerCase()
}

export function isPosix(file: string) {
  return POSIX_NAMES.has(nameOf(file))
}

export function isPs(file: string) {
  const name = nameOf(file)
  return name === "pwsh" || name === "powershell"
}

// D-W2 default Windows shell chain, strict: pwsh → powershell → cmd (COMSPEC), with cmd.exe as
// the guaranteed-present floor. Git Bash deliberately stays OUT of the silent default — it remains
// selectable per configuration and stays in the full winChain enumeration that validation uses to
// find a faithful POSIX interpreter. Probes are injected so the order is pinnable on any host.
export function defaultWindowsChain(probe: { pwsh?: string; powershell?: string; comspec?: string }): string {
  return probe.pwsh ?? probe.powershell ?? (probe.comspec || "cmd.exe")
}

function kindOf(file: string): "bash" | "pwsh" | "powershell" | "cmd" {
  const name = nameOf(file)
  if (name === "pwsh" || name === "powershell" || name === "cmd") return name
  return "bash"
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

export const parse = Effect.fn("ShellScan.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.tryPromise({
    try: () => parser().then((p) => (ps ? p.ps : p.bash).parse(command)),
    catch: () => new ParseError({ command }),
  })
  if (!tree) return yield* new ParseError({ command })
  return tree
})

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child: Node | null): child is Node => child !== null)
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

const cygpath = Effect.fn("ShellScan.cygpath")(function* (io: IO, shell: string, text: string) {
  const lines = yield* io
    .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
    .pipe(Effect.catch(() => Effect.succeed([] as string[])))
  const file = lines[0]?.trim()
  if (!file) return
  return FSUtil.normalizePath(file)
})

export const resolvePath = Effect.fn("ShellScan.resolvePath")(function* (
  io: IO,
  text: string,
  root: string,
  shell: string,
) {
  if (process.platform === "win32") {
    if (isPosix(shell) && text.startsWith("/") && FSUtil.windowsPath(text) === text) {
      const file = yield* cygpath(io, shell, text)
      if (file) return file
    }
    return FSUtil.normalizePath(path.resolve(root, FSUtil.windowsPath(text)))
  }
  return path.resolve(root, text)
})

const argPath = Effect.fn("ShellScan.argPath")(function* (
  io: IO,
  arg: string,
  cwd: string,
  ps: boolean,
  shell: string,
) {
  const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
  const file = text && prefix(text)
  if (!file || dynamic(file, ps)) return
  const next = ps ? provider(file) : file
  if (!next) return
  return yield* resolvePath(io, next, cwd, shell)
})

export const collect = Effect.fn("ShellScan.collect")(function* (
  io: IO,
  root: Node,
  cwd: string,
  ps: boolean,
  shell: string,
  contains: (candidate: string) => boolean,
) {
  const scan: Scan = {
    dirs: new Set<string>(),
    patterns: new Set<string>(),
    always: new Set<string>(),
  }
  const shellKind = kindOf(shell)

  for (const node of commands(root)) {
    const command = parts(node)
    const tokens = command.map((item) => item.text)
    const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]

    if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
      for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
        const resolved = yield* argPath(io, arg, cwd, ps, shell)
        log.info("resolved path", { arg, resolved })
        if (!resolved || contains(resolved)) continue
        const dir = (yield* io.isDir(resolved)) ? resolved : path.dirname(resolved)
        scan.dirs.add(dir)
      }
    }

    if (tokens.length && (!cmd || !CWD.has(cmd))) {
      scan.patterns.add(source(node))
      scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
    }
  }

  return scan
})
