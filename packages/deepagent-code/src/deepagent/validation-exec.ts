import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { buffer } from "node:stream/consumers"
import { Process } from "@/util/process"
import { Shell } from "@/shell/shell"

// V3 A3: real validation executor. Runs the workspace validation commands (typecheck / lint /
// test, inferred by workspace-context) and maps each to the universal ValidationResult the
// orchestrator consumes. Used by the multi-round loop to get ground-truth pass/fail evidence.

export type ValidationResult = ReturnType<typeof AgentGateway.DeepAgentValidation.parseValidationOutput>

export function validationInvocation(command: string, cwd: string, shell = Shell.acceptable()) {
  return [shell, ...Shell.args(shell, command, cwd)]
}

export const runValidationCommands = async (
  commands: readonly string[],
  cwd: string,
  timeoutMs = 120_000,
  options?: { shell?: string },
): Promise<ValidationResult[]> => {
  const results: ValidationResult[] = []
  for (const command of commands) {
    const started = Date.now()
    const invocation = validationInvocation(command, cwd, options?.shell)
    try {
      const proc = Process.spawn(invocation, {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      })
      const stdout = proc.stdout
      const stderr = proc.stderr
      if (!stdout || !stderr) throw new Error("Validation process output is unavailable")
      // P2-5: race the full read+exit against a timeout sentinel. On timeout we kill the process
      // AND resolve immediately to a failed result, instead of awaiting stdout that may never close
      // after kill (the previous code could hang on `Response(proc.stdout).text()`).
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          try {
            proc.kill()
          } catch {}
          resolve("timeout")
        }, timeoutMs)
      })
      const completed = (async () => {
        const [output, error, exitCode] = await Promise.all([buffer(stdout), buffer(stderr), proc.exited])
        return { stdout: output.toString(), stderr: error.toString(), exitCode } as const
      })()

      const outcome = await Promise.race([completed, timeout])
      if (timer) clearTimeout(timer)
      if (outcome === "timeout") {
        results.push(
          AgentGateway.DeepAgentValidation.parseValidationOutput(
            command,
            124, // conventional timeout exit code
            `validation command timed out after ${timeoutMs}ms`,
            Date.now() - started,
          ),
        )
        continue
      }
      const output = `${outcome.stdout}\n${outcome.stderr}`.trim()
      results.push(
        AgentGateway.DeepAgentValidation.parseValidationOutput(command, outcome.exitCode, output, Date.now() - started),
      )
    } catch (err) {
      results.push(
        AgentGateway.DeepAgentValidation.parseValidationOutput(
          command,
          127,
          `validation shell bootstrap failed (${invocation[0]}): ${String(err)}`,
          Date.now() - started,
        ),
      )
    }
  }
  return results
}
