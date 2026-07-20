import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"

const id = "dismiss_validation_failure"

const DESCRIPTION = [
  "Dismiss a specific validation failure so it is no longer re-injected into every round's context.",
  "Use this only when you have VERIFIED that a failing validation result is a known false positive,",
  "an environment-specific flake, or a failure you have already handled and do not need to be reminded of.",
  "The dismissal is permanent for this session but auto-evicted if the same command re-runs with a",
  "DIFFERENT exit code (i.e. a real regression always surfaces again).",
  "You must supply the exact command and exit_code that appear in the current validation results —",
  "the tool validates both fields against the live lastValidationResults before storing the dismissal.",
  "Security-sensitive commands (auth, credentials, permissions, …) cannot be dismissed.",
].join(" ")

/**
 * Patterns that make a command ineligible for dismissal. These cover scenarios where a failing
 * validation almost certainly reflects a real security or integrity concern that the model should
 * not be allowed to silently suppress.
 */
const DISMISS_BLACKLIST_PATTERNS: RegExp[] = [
  /\bsecurity\b/i,
  /\bauth\b/i,
  /\bpassword\b/i,
  /\bcredential\b/i,
  /\bpermission\b/i,
  /\bcritical\b/i,
]

const Parameters = Schema.Struct({
  command: Schema.String.annotate({
    description:
      "The exact failing command to dismiss — must match an entry in the current lastValidationResults with passed=false.",
  }),
  exit_code: Schema.Number.annotate({
    description:
      "The exit code of the failing run. Double-confirms the target: if the command is present but with a different exit code, the dismissal is rejected.",
  }),
  reason: Schema.String.annotate({
    description: "Plain-text explanation of why this failure is safe to dismiss (stored for audit).",
  }),
})

type Metadata = {
  command: string
  exit_code: number
  fingerprint: string
}

function reject(detail: string): never {
  throw new Tool.InvalidArgumentsError({ tool: id, detail })
}

/**
 * PR-4: model-callable tool that explicitly dismisses a validation failure from round-context
 * re-injection. The handler validates the target against the live lastValidationResults before
 * calling suppressValidation(), so the model cannot dismiss a failure that does not actually
 * exist, and cannot dismiss by fingerprint alone (both command AND exit code must match).
 */
export const DismissValidationTool = Tool.define<typeof Parameters, Metadata, never>(
  id,
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
      Effect.gen(function* () {
        const { command, exit_code, reason } = params

        // Blacklist check — reject before touching any state.
        for (const pattern of DISMISS_BLACKLIST_PATTERNS) {
          if (pattern.test(command)) {
            reject(
              `Commands matching the pattern /${pattern.source}/i cannot be dismissed for security reasons.`,
            )
          }
        }

        // Read the live validation results for this session.
        const sessionState = AgentGateway.DeepAgentSessionState.get(ctx.sessionID)
        if (!sessionState) {
          reject("No session state found. Cannot verify the target failure.")
        }

        const results = sessionState.lastValidationResults
        if (results.length === 0) {
          reject("There are no recorded validation results in this session. Nothing to dismiss.")
        }

        // Find an exact match: command AND exit_code, and must be failing.
        const matches = results.filter((r) => r.command === command && !r.passed)
        if (matches.length === 0) {
          const allCmds = results.map((r) => `${r.command} (exit=${r.exit_code}, passed=${r.passed})`).join("; ")
          reject(`No FAILING validation result found for command "${command}". Current results: ${allCmds}`)
        }

        // Verify exit_code matches exactly.
        const target = matches.find((r) => r.exit_code === exit_code)
        if (!target) {
          const exitCodes = matches.map((r) => r.exit_code).join(", ")
          reject(
            `Command "${command}" failed but with exit code(s) [${exitCodes}], not ${exit_code}. Supply the correct exit code.`,
          )
        }

        // All checks passed — record the dismissal.
        const fingerprint = `${command} ${exit_code}`
        AgentGateway.DeepAgentSessionState.suppressValidation(ctx.sessionID, command, exit_code, reason)

        return {
          title: `Dismissed: ${command}`,
          metadata: { command, exit_code, fingerprint },
          output: [
            `Dismissed validation failure for: ${command} (exit code ${exit_code})`,
            `Reason: ${reason}`,
            `Fingerprint: ${fingerprint}`,
            "",
            "This failure will no longer appear in round context. It will be automatically",
            "re-surfaced if the command re-runs with a different exit code.",
          ].join("\n"),
        }
      }),
  }),
)
