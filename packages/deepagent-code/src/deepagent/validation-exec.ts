import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import type { ValidationCommand, ValidationCommandInput } from "@deepagent-code/core/deepagent/validation"
import type { ValidationFailureKind } from "@deepagent-code/core/deepagent/round-state"
import { buffer } from "node:stream/consumers"
import { release } from "node:os"
import { Process } from "@/util/process"
import { Shell } from "@/shell/shell"
import { ShellDialect } from "@/shell/dialect"

export type ValidationResult = ReturnType<typeof AgentGateway.DeepAgentValidation.parseValidationOutput>

type Invocation =
  | { readonly argv: readonly string[] }
  | { readonly kind: "unsupported_platform" | "unsupported_dialect"; readonly detail: string }

// Host shell probes, injectable so the win32 selection logic is pinned by tests on any host. The
// defaults hit the real resolver; win() is the D-W2 fallback chain (pwsh → powershell → gitbash →
// cmd), and gitbash() honors DEEPAGENT_CODE_GIT_BASH_PATH before auto-detection.
export type ShellProbe = {
  readonly gitbash: () => string | undefined
  readonly win: () => string[]
  readonly acceptable: () => string
}

const defaultProbe: ShellProbe = {
  gitbash: () => Shell.gitbash(),
  win: () => Shell.win(),
  acceptable: () => Shell.acceptable(),
}

type ValidationOptions = {
  readonly shell?: string
  readonly platform?: NodeJS.Platform
  readonly release?: string
  readonly env?: NodeJS.ProcessEnv
  readonly probe?: ShellProbe
}

export function validationInvocation(
  input: ValidationCommandInput,
  cwd: string,
  options?: ValidationOptions,
): Invocation {
  const command = AgentGateway.DeepAgentValidation.normalizeValidationCommand(input)
  const platform = options?.platform ?? process.platform
  const platformFailure = unsupportedPlatform(platform, options?.release ?? release(), options?.env ?? process.env)
  if (platformFailure) return { kind: "unsupported_platform", detail: platformFailure }
  if (command.transport === "argv") return { argv: [command.executable, ...command.args] }

  if (options?.shell) return posixScriptInvocation(options.shell, command, cwd)
  if (platform === "win32") return win32PosixInvocation(command, cwd, options?.probe ?? defaultProbe)

  const shell = validationShell(options?.probe ?? defaultProbe)
  if (!shell)
    return {
      kind: "unsupported_dialect",
      detail: `No ${command.transport} interpreter is available for validation command "${command.display}"`,
    }
  return { argv: [shell, ...Shell.args(shell, command.script, cwd)] }
}

export const runValidationCommands = async (
  commands: readonly ValidationCommandInput[],
  cwd: string,
  timeoutMs = 120_000,
  options?: ValidationOptions,
): Promise<ValidationResult[]> => {
  const results: ValidationResult[] = []
  for (const input of commands) {
    const command = AgentGateway.DeepAgentValidation.normalizeValidationCommand(input)
    const started = Date.now()
    const invocation = validationInvocation(command, cwd, options)
    if ("kind" in invocation) {
      results.push(result(command.display, -1, invocation.detail, started, invocation.kind))
      continue
    }

    try {
      const proc = Process.spawn([...invocation.argv], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      })
      if (!proc.stdout || !proc.stderr) {
        proc.kill()
        results.push(
          result(
            command.display,
            -1,
            `Validation process output is unavailable for ${invocation.argv[0]}`,
            started,
            "output_unavailable",
          ),
        )
        continue
      }

      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          try {
            proc.kill()
          } catch {}
          resolve("timeout")
        }, timeoutMs)
      })
      const completed = Promise.all([buffer(proc.stdout), buffer(proc.stderr), proc.exited]).then(
        ([stdout, stderr, exitCode]) => ({
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          exitCode,
        }),
      )
      const outcome = await Promise.race([completed, timeout])
      if (timer) clearTimeout(timer)
      if (outcome === "timeout") {
        results.push(
          result(
            command.display,
            124,
            `validation command timed out after ${timeoutMs}ms`,
            started,
            "timeout",
          ),
        )
        continue
      }
      results.push(
        result(
          command.display,
          outcome.exitCode,
          `${outcome.stdout}\n${outcome.stderr}`.trim(),
          started,
          proc.signalCode ? "signal" : "command_exit",
        ),
      )
    } catch (error) {
      results.push(
        result(
          command.display,
          -1,
          `validation process bootstrap failed (${invocation.argv[0]}): ${String(error)}`,
          started,
          "shell_bootstrap_failed",
        ),
      )
    }
  }
  return results
}

// POSIX hosts keep the pre-existing contract: the accepted user shell when it is POSIX, else sh.
function validationShell(probe: ShellProbe) {
  const shell = probe.acceptable()
  return Shell.posix(shell) ? shell : "/bin/sh"
}

// A POSIX script under an explicitly chosen shell still has to be expressible in that shell's
// dialect (405-002 RC-2); posix shells accept it verbatim.
function posixScriptInvocation(shell: string, command: Extract<ValidationCommand, { transport: "posix" }>, cwd: string): Invocation {
  const dialect = ShellDialect.ofShellName(shell)
  if (dialect === "posix") return { argv: [shell, ...Shell.args(shell, command.script, cwd)] }
  const check = ShellDialect.checkPosixScript(command.script, dialect)
  if (check.ok) return { argv: [shell, ...Shell.args(shell, command.script, cwd)] }
  return {
    kind: "unsupported_dialect",
    detail: `Validation command "${command.display}" uses POSIX-only syntax the ${dialect} shell cannot express: ${check.issues
      .map((issue) => issue.detail)
      .join("; ")}`,
  }
}

// Native Windows (D-W2): Git Bash preserves POSIX semantics outright; otherwise the fallback chain
// (pwsh → powershell → cmd) picks the FIRST shell whose dialect can express the script. No
// translation is attempted — a command no candidate can express fails closed as
// unsupported_dialect, pointing at Git Bash as the escape hatch.
function win32PosixInvocation(
  command: Extract<ValidationCommand, { transport: "posix" }>,
  cwd: string,
  probe: ShellProbe,
): Invocation {
  const gitbash = probe.gitbash()
  if (gitbash) return { argv: [gitbash, ...Shell.args(gitbash, command.script, cwd)] }

  const rejected: string[] = []
  for (const shell of probe.win()) {
    const dialect = ShellDialect.ofShellName(shell)
    if (dialect === "posix") return { argv: [shell, ...Shell.args(shell, command.script, cwd)] }
    const check = ShellDialect.checkPosixScript(command.script, dialect)
    if (check.ok) return { argv: [shell, ...Shell.args(shell, command.script, cwd)] }
    rejected.push(`${dialect}: ${check.issues.map((issue) => issue.detail).join("; ")}`)
  }
  return {
    kind: "unsupported_dialect",
    detail:
      `No available Windows shell can safely express POSIX validation command "${command.display}" ` +
      `(tried ${rejected.length ? rejected.join(" | ") : "no shells"}). ` +
      `Install Git Bash or set DEEPAGENT_CODE_GIT_BASH_PATH to run POSIX validation commands natively.`,
  }
}

// WSL1 stays rejected; native Windows is served by the win32 dialect chain above (D-W2).
function unsupportedPlatform(platform: NodeJS.Platform, kernelRelease: string, env: NodeJS.ProcessEnv) {
  if (platform !== "linux") return
  const version = kernelRelease.toLowerCase()
  const wsl = Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP || version.includes("microsoft"))
  if (wsl && !version.includes("microsoft-standard") && !version.includes("wsl2"))
    return "WSL1 validation is unsupported. Upgrade the distribution to WSL2 and reconnect the WSL server."
}

function result(
  command: string,
  exitCode: number,
  output: string,
  started: number,
  kind: ValidationFailureKind,
) {
  return AgentGateway.DeepAgentValidation.parseValidationOutput(command, exitCode, output, Date.now() - started, kind)
}
