import { describe, expect, test } from "bun:test"
import { runValidationCommands } from "../../src/deepagent/validation-exec"

// V3.2 P2-5 regression guard: a validation command that never exits must NOT hang the runner.
// The timeout sentinel must kill the process and resolve to a failed ValidationResult within
// roughly the timeout window.
describe("V3.2 validation-exec timeout", () => {
  test("a non-exiting command resolves to a failed result near the timeout", async () => {
    const started = Date.now()
    const results = await runValidationCommands(["sleep 30"], process.cwd(), 300)
    const elapsed = Date.now() - started
    expect(results).toHaveLength(1)
    expect(results[0]!.passed).toBe(false)
    // resolved promptly (well before the 30s sleep), not hung
    expect(elapsed).toBeLessThan(5000)
  })

  test("a fast successful command still passes", async () => {
    const results = await runValidationCommands(["true"], process.cwd(), 5000)
    expect(results[0]!.passed).toBe(true)
  })
})
