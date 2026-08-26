import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import type { ValidationCommandInput } from "@deepagent-code/core/deepagent/validation"
import type { ValidationFailureKind } from "@deepagent-code/core/deepagent/round-state"
import { buffer } from "node:stream/consumers"
import { release } from "node:os"
import { Process } from "@/util/process"
import { Shell } from "@/shell/shell"

export type ValidationResult = ReturnType<typeof AgentGateway.DeepAgentValidation.parseValidationOutput>

type Invocation =
  | { readonly argv: readonly string[] }
  | { readonly kind: "unsupported_platform" | "unsupported_dialect"; readonly detail: string }

type ValidationOptions = {
  readonly shell?: string
  readonly platform?: NodeJS.Platform
  readonly release?: string
  readonly env?: NodeJS.ProcessEnv
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

  const shell = options?.shell ?? validationShell()
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

function validationShell() {
  const shell = Shell.acceptable()
  return Shell.posix(shell) ? shell : "/bin/sh"
}

function unsupportedPlatform(platform: NodeJS.Platform, kernelRelease: string, env: NodeJS.ProcessEnv) {
  if (platform === "win32")
    return "Native Windows validation is unsupported. Connect the desktop app to a DeepAgent Code server running in WSL2."
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
