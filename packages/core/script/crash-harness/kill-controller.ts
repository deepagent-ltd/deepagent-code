import { spawn, type ChildProcess } from "node:child_process"
import { rmSync } from "node:fs"

// C0-04 - kill controller: spawn a harness child process, arm a kill at a
// named milestone, and return the process handle + exit signal. Never used by
// production src (script+test only).

export interface Spawned {
  readonly child: ChildProcess
  readonly ready: Promise<void>
  readonly committed: Promise<void>
  readonly done: Promise<void>
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

export interface MilestoneNotifier {
  /** Wait until the child prints exactly this milestone line. */
  readonly wait: (line: string) => Promise<void>
}

export function spawnHarnessChild(args: { readonly run: string; readonly childArgs: readonly string[]; readonly cwd: string; readonly env?: Readonly<Record<string, string>> }): Spawned {
  const child = spawn("bun", ["run", args.run, ...args.childArgs], { cwd: args.cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...(args.env ?? {}) } })
  const listeners: Record<string, (() => void)[]> = {}
  let exited = false
  const exitResolvers: ((v: { code: number | null; signal: NodeJS.Signals | null }) => void)[] = []
  const notify = (line: string) => {
    for (const fn of listeners[line] ?? []) fn()
    listeners[line] = []
  }
  let buffer = ""
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString()
    let idx: number
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line) notify(line)
    }
  })
  child.on("exit", (code, signal) => {
    exited = true
    for (const resolve of exitResolvers) resolve({ code, signal })
  })
  const wait = (line: string) =>
    new Promise<void>((resolve) => {
      if (exited) return resolve()
      ;(listeners[line] ??= []).push(resolve)
    })
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    exitResolvers.push(resolve)
  })
  return {
    child,
    ready: wait("HARNESS_READY"),
    committed: wait("HARNESS_COMMITTED"),
    done: wait("HARNESS_DONE"),
    exit,
  }
}

export function killHard(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
  if (child.exitCode === null && !child.killed) {
    child.kill(signal)
  }
}

/** Clean a scratch dir owned by a harness run (never anything else). */
export function removeScratch(scratch: string): void {
  if (scratch.includes("crash-harness") && scratch.startsWith(process.env.DEEPAGENT_CODE_TEST_HOME ?? "/")) {
    rmSync(scratch, { recursive: true, force: true })
  }
}
