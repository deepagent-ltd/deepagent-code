// Subprocess integration tests for `deepagentCode run` (non-interactive mode).
// These exercise the real CLI binary against a TestLLMServer running in the
// same process. See `test/lib/cli-process.ts` for the harness — each test uses
// `deepagentCode.run(message, opts?)` to spawn `bun src/index.ts run ...` with
// `DEEPAGENT_CODE_CONFIG_CONTENT` providing the test provider config inline.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"

describe("deepagentCode run (non-interactive subprocess)", () => {
  // Happy path: prompt completes, output reaches stdout, process exits 0.
  // If this fails, all the others likely will too — debug here first.
  cliIt.concurrent(
    "exits 0 and writes the response to stdout on a successful prompt",
    ({ llm, deepagentCode }) =>
      Effect.gen(function* () {
        yield* llm.text("hello from the test llm")
        const result = yield* deepagentCode.run("say hi")
        deepagentCode.expectExit(result, 0)
        expect(result.stdout).toContain("hello from the test llm")
      }),
    60_000,
  )

  cliIt.concurrent(
    "auto-approves an asked permission without human input when explicitly requested",
    ({ llm, home, deepagentCode }) =>
      Effect.gen(function* () {
        const target = path.join(home, ".env")
        yield* Effect.promise(() => Bun.write(target, "UNATTENDED_PERMISSION_MARKER\n"))
        yield* llm.tool("read", { filePath: target })
        yield* llm.text("permission flow completed")

        const result = yield* deepagentCode.run("read the marker", {
          format: "json",
          extraArgs: ["--dangerously-skip-permissions"],
        })
        deepagentCode.expectExit(result, 0)

        const events = deepagentCode.parseJsonEvents(result.stdout)
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "permission",
            reply: "once",
          }),
        )
        expect(
          events.some(
            (event) =>
              event.type === "tool_use" &&
              typeof event.part === "object" &&
              event.part !== null &&
              "tool" in event.part &&
              event.part.tool === "read",
          ),
        ).toBe(true)
      }),
    60_000,
  )

  // Regression for #27371: an unknown model used to hang the process forever
  // waiting on a session.status === idle event that never arrived. The fix
  // makes the SDK call surface an error promptly so the process exits nonzero.
  // We assert nonzero exit AND wall-clock under the harness timeout — a hang
  // would expire the timeout and produce a different (signal-killed) failure.
  cliIt.concurrent(
    "exits nonzero promptly when the model is unknown (regression for #27371)",
    ({ deepagentCode }) =>
      Effect.gen(function* () {
        const result = yield* deepagentCode.run("say hi", {
          model: "test/nonexistent-model",
          timeoutMs: 15_000,
        })
        expect(result.exitCode).not.toBe(0)
        expect(result.durationMs).toBeLessThan(15_000)
      }),
    30_000,
  )

  cliIt.concurrent(
    "exits nonzero when the LLM stream fails mid-response",
    ({ llm, deepagentCode }) =>
      Effect.gen(function* () {
        yield* llm.fail("upstream provider exploded mid-stream")
        const result = yield* deepagentCode.run("trigger midstream error", { timeoutMs: 30_000 })
        expect(result.exitCode).not.toBe(0)
      }),
    60_000,
  )

  // --format json puts one JSON object per line on stdout for each emitted
  // event. Consumers (CI scripts, tooling) parse this stream. Asserts the
  // shape so a future event-emit change has to update this expectation.
  cliIt.concurrent(
    "--format json emits parseable line-delimited JSON to stdout",
    ({ llm, deepagentCode }) =>
      Effect.gen(function* () {
        yield* llm.text("structured output")
        const result = yield* deepagentCode.run("say hi", { format: "json" })
        deepagentCode.expectExit(result, 0)

        const events = deepagentCode.parseJsonEvents(result.stdout)
        expect(events.length).toBeGreaterThan(0)
        for (const evt of events) {
          expect(typeof evt.type).toBe("string")
          expect(typeof evt.sessionID).toBe("string")
        }
        // At least one `text` event should appear with the LLM's response.
        const text = events.find((e) => e.type === "text")
        expect(text).toBeDefined()
      }),
    60_000,
  )

  cliIt.concurrent(
    "resolves attachments from the real cwd when inherited PWD is stale",
    ({ llm, home, deepagentCode }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => Bun.write(path.join(home, "attachment.txt"), "ATTACHMENT_MARKER\n"))
        yield* llm.text("attachment accepted")

        const result = yield* deepagentCode.spawn(
          ["run", "inspect the attachment", "--model", "test/test-model", "--file", "attachment.txt"],
          { env: { PWD: path.join(home, "stale-pwd") } },
        )
        deepagentCode.expectExit(result, 0)
        expect(result.stdout).toContain("attachment accepted")
      }),
    60_000,
  )
})
