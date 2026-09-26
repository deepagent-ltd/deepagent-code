// Subprocess integration tests for `deepagentCode run` (non-interactive mode).
// These exercise the real CLI binary against a TestLLMServer running in the
// same process. See `test/lib/cli-process.ts` for the harness — each test uses
// `deepagentCode.run(message, opts?)` to spawn `bun src/index.ts run ...` with
// `DEEPAGENT_CODE_CONFIG_CONTENT` providing the test provider config inline.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Database } from "bun:sqlite"
import { cliIt } from "../../lib/cli-process"
import { CompositionDigest } from "../../../src/effect/composition-digest"

const goalEnvironment = {
  DEEPAGENT_ENABLED: "true",
  DEEPAGENT_CODE_EXPERIMENTAL_GOAL_LOOP: "true",
  DEEPAGENT_CODE_V4_MULTI_AGENT_RUNTIME: "false",
  DEEPAGENT_CODE_V4_GOAL_TICK_EVENT_DRIVEN: "false",
}

const completeCurrentPlan = (hit: { body: Record<string, unknown> }) => {
  const precondition = JSON.stringify(hit.body).match(
    /Plan write precondition: expected_plan_id=\\"([^\"]+)\\" expected_version=(\d+)/,
  )
  if (!precondition) throw new Error("goal-worker prompt omitted the plan precondition")
  return {
    name: "plan",
    input: {
      operation: "advance",
      expected_plan_id: precondition[1],
      expected_version: Number(precondition[2]),
      steps: [{ step_id: "step_1", status: "done" }],
      active_step_id: null,
    },
  }
}

describe("deepagentCode run (non-interactive subprocess)", () => {
  // Each case starts a full CLI process. Running them concurrently can starve startup
  // on loaded CI runners and hit the subprocess timeout before the case begins.
  cliIt.live(
    "preserves committed custom tool history after uninstall and process restart",
    ({ llm, home, deepagentCode }) =>
      Effect.gen(function* () {
        const databasePath = path.join(home, "historical-tool.db")
        const toolPath = path.join(home, ".deepagent", "code", "tools", "historical.ts")
        const pluginTool = pathToFileURL(path.resolve(import.meta.dir, "../../../../plugin/src/tool.ts")).href
        const marker = "HISTORICAL_TOOL_RESULT_8f53"
        yield* Effect.promise(() => mkdir(path.dirname(toolPath), { recursive: true }))
        yield* Effect.promise(() =>
          Bun.write(
            toolPath,
            [
              `import { tool } from ${JSON.stringify(pluginTool)}`,
              "export default tool({",
              "  description: 'Return the exact historical marker',",
              "  args: { challenge: tool.schema.string() },",
              `  execute: async ({ challenge }) => ${JSON.stringify(marker)} + ':' + challenge,`,
              "})",
              "",
            ].join("\n"),
          ),
        )

        yield* llm.tool("historical", { challenge: "byte-for-byte" })
        yield* llm.text("first turn complete")
        const first = yield* deepagentCode.run("call historical tool", {
          format: "json",
          extraArgs: ["--dangerously-skip-permissions"],
          env: { DEEPAGENT_CODE_DB: databasePath },
          timeoutMs: 60_000,
        })
        deepagentCode.expectExit(first, 0)
        const sessionID = deepagentCode.parseJsonEvents(first.stdout).find((event) => typeof event.sessionID === "string")
          ?.sessionID
        if (typeof sessionID !== "string") throw new Error("first run emitted no session ID")

        // Read with a new SQLite connection after the first process exited: the result must be
        // committed, not merely retained by the process-local tool registry or runner cache.
        const database = new Database(databasePath, { readonly: true })
        const committed = database
          .query("SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq")
          .all(sessionID) as Array<{ data: string }>
        database.close()
        expect(committed.some((row) => row.data.includes(`${marker}:byte-for-byte`))).toBe(true)

        const beforeRestart = yield* llm.hits
        const firstEgress = beforeRestart.find((hit) =>
          JSON.stringify(hit.body.messages ?? []).includes(`${marker}:byte-for-byte`),
        )
        if (!firstEgress) throw new Error("tool result was not sent in the first process")
        const historicalPair = (firstEgress.body.messages as Array<Record<string, unknown>>).filter(
          (message) =>
            (message.role === "assistant" && JSON.stringify(message.tool_calls ?? []).includes("historical")) ||
            (message.role === "tool" && JSON.stringify(message.content ?? "").includes(marker)),
        )
        expect(historicalPair).toHaveLength(2)

        yield* Effect.promise(() => Bun.file(toolPath).delete())
        yield* llm.text("second turn complete")
        const second = yield* deepagentCode.run("continue after uninstall", {
          format: "json",
          extraArgs: ["--session", sessionID],
          env: { DEEPAGENT_CODE_DB: databasePath },
          timeoutMs: 60_000,
        })
        deepagentCode.expectExit(second, 0)

        const afterRestart = (yield* llm.hits)
          .slice(beforeRestart.length)
          .find(
            (hit) =>
              Array.isArray(hit.body.tools) &&
              JSON.stringify(hit.body.messages ?? []).includes("continue after uninstall"),
          )
        if (!afterRestart) throw new Error("second process sent no continuation provider request")
        const messages = afterRestart.body.messages as Array<Record<string, unknown>>
        expect(
          JSON.stringify(
            messages.filter(
              (message) =>
                (message.role === "assistant" && JSON.stringify(message.tool_calls ?? []).includes("historical")) ||
                (message.role === "tool" && JSON.stringify(message.content ?? "").includes(marker)),
            ),
          ),
        ).toBe(JSON.stringify(historicalPair))
        expect(
          (afterRestart.body.tools as Array<{ function?: { name?: string } }>).map((entry) => entry.function?.name),
        ).not.toContain("historical")
      }),
    120_000,
  )

  // Happy path: prompt completes, output reaches stdout, process exits 0.
  // If this fails, all the others likely will too — debug here first.
  cliIt.live(
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

  cliIt.live(
    "logs the embedded composition digest and compares attach with the remote root",
    ({ llm, deepagentCode }) =>
      Effect.gen(function* () {
        yield* llm.text("local composition response")
        const local = yield* deepagentCode.run("local composition", { env: { DEEPAGENT_CODE_DB: ":memory:" } })
        deepagentCode.expectExit(local, 0)
        const localHash = local.stderr.match(/\[composition\] digest=([0-9a-f]{12})/)
        expect(localHash?.[1]).toMatch(/^[0-9a-f]{12}$/)

        const server = yield* deepagentCode.serve({ env: { DEEPAGENT_CODE_DB: ":memory:" } })
        const response = yield* Effect.promise(() => fetch(`${server.url}/composition/digest`))
        expect(response.status).toBe(200)
        const remote = (yield* Effect.promise(() => response.json())) as CompositionDigest.Record
        expect(localHash?.[1]).toBe(remote.digest.slice(0, 12))

        yield* llm.text("attached composition response")
        const attached = yield* deepagentCode.run("attached composition", {
          env: { DEEPAGENT_CODE_DB: ":memory:" },
          extraArgs: ["--attach", server.url],
        })
        deepagentCode.expectExit(attached, 0)
        expect(attached.stderr).toContain(`[composition] digest=${remote.digest.slice(0, 12)} remote=match`)

        yield* llm.text("different local composition response")
        const mismatched = yield* deepagentCode.run("compare different local database", {
          env: { DEEPAGENT_CODE_DB: "composition-client.db" },
          extraArgs: ["--attach", server.url],
        })
        deepagentCode.expectExit(mismatched, 0)
        expect(mismatched.stderr).toMatch(
          new RegExp(
            `\\[composition\\] warning: attach digest differs local=[0-9a-f]{12} remote=${remote.digest.slice(0, 12)}`,
          ),
        )
      }),
    120_000,
  )

  cliIt.live(
    "auto-approves an asked permission without human input when explicitly requested",
    ({ llm, home, deepagentCode }) =>
      Effect.gen(function* () {
        // V2 read hard-errors on external absolute paths (no permission path); write is the tool
        // that surfaces the external_directory approval this scenario is about.
        const target = path.join(home, "marker.txt")
        yield* llm.tool("write", { path: target, content: "UNATTENDED_PERMISSION_MARKER\n" })
        yield* llm.text("permission flow completed")

        const result = yield* deepagentCode.run("write the marker", {
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
              event.part.tool === "write",
          ),
        ).toBe(true)
        // The approval must be effective: the write reached the disk.
        expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(true)
      }),
    60_000,
  )

  // PARITY-002: --permission-mode read-only mirrors the GUI read-only
  // directory mode — mutating permissions are auto-rejected. In this harness
  // the session root differs from the tmp home, so file tools surface the
  // external_directory permission, which is part of the shared mutating set.
  cliIt.live(
    "read-only permission mode rejects mutating permissions",
    ({ llm, home, deepagentCode }) =>
      Effect.gen(function* () {
        yield* llm.tool("write", { path: path.join(home, "mutated.txt"), content: "nope\n" })
        yield* llm.text("read-only flow completed")

        const result = yield* deepagentCode.run("try to mutate", {
          format: "json",
          extraArgs: ["--permission-mode", "read-only"],
        })
        deepagentCode.expectExit(result, 0)

        const events = deepagentCode.parseJsonEvents(result.stdout)
        const permissions = events.filter((event) => event.type === "permission")
        expect(permissions.length).toBeGreaterThan(0)
        for (const event of permissions) {
          expect(event.reply).toBe("reject")
        }
        expect(permissions).toContainEqual(
          expect.objectContaining({
            type: "permission",
            reply: "reject",
            request: expect.objectContaining({ permission: "external_directory" }),
          }),
        )
        // The rejection must be effective: no mutation reached the disk.
        const mutated = yield* Effect.promise(() => Bun.file(path.join(home, "mutated.txt")).exists())
        expect(mutated).toBe(false)
      }),
    60_000,
  )

  // Regression for #27371: an unknown model used to hang the process forever
  // waiting on a session.status === idle event that never arrived. The fix
  // makes the SDK call surface an error so the process exits on its own. Under
  // full-package load CLI startup can exceed 15s, so give the harness a separate
  // 45s kill limit and require a real CLI exit inside a 35s behavioral bound.
  cliIt.live(
    "exits nonzero promptly when the model is unknown (regression for #27371)",
    ({ deepagentCode }) =>
      Effect.gen(function* () {
        const result = yield* deepagentCode.run("say hi", {
          model: "test/nonexistent-model",
          format: "json",
          timeoutMs: 45_000,
        })
        if (result.termination !== "exited")
          throw new Error(`unknown-model CLI was ${result.termination} after ${result.durationMs}ms: ${result.stderr}`)
        expect(result.exitCode).not.toBe(0)
        expect(result.durationMs).toBeLessThan(35_000)
        expect(deepagentCode.parseJsonEvents(result.stdout).some((event) =>
          event.type === "error" && typeof event.error === "string" && event.error.length > 0)).toBe(true)
      }),
    60_000,
  )

  cliIt.live(
    "distinguishes a harness deadline from a CLI error exit",
    ({ deepagentCode }) =>
      Effect.gen(function* () {
        const result = yield* deepagentCode.run("a deadline before startup", { timeoutMs: 1 })
        expect(result.termination).toBe("harness_timeout")
        expect(result.stdout).toBe("")
      }),
    30_000,
  )

  cliIt.live(
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
  cliIt.live(
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

  cliIt.live(
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

  cliIt.live(
    "inlines a directory attachment as a listing instead of sending x-directory media on the wire",
    ({ llm, home, deepagentCode }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => mkdir(path.join(home, "attached-dir")))
        yield* Effect.promise(() => Bun.write(path.join(home, "attached-dir", "marker-entry.txt"), "MARKER\n"))
        yield* llm.text("directory accepted")

        const result = yield* deepagentCode.spawn(
          ["run", "inspect the directory", "--model", "test/test-model", "--file", "attached-dir"],
          { env: { PWD: path.join(home, "stale-pwd") } },
        )
        deepagentCode.expectExit(result, 0)
        expect(result.stdout).toContain("directory accepted")

        const wire = JSON.stringify((yield* llm.hits)[0]?.body)
        expect(wire).toContain("<attached-directory")
        expect(wire).toContain("<type>directory</type>")
        expect(wire).toContain("marker-entry.txt")
        expect(wire).not.toContain("application/x-directory")
      }),
    60_000,
  )

  cliIt.live(
    "requires the loop agent for the scriptable goal entry",
    ({ deepagentCode }) =>
      Effect.gen(function* () {
        const result = yield* deepagentCode.run("finish the goal", {
          agent: "general",
          extraArgs: ["--goal"],
        })
        expect(result.exitCode).not.toBe(0)
        expect(`${result.stdout}\n${result.stderr}`).toContain("--goal requires --agent loop")
      }),
    30_000,
  )

  cliIt.live(
    "requires a fresh session for the scriptable goal entry",
    ({ deepagentCode }) =>
      Effect.gen(function* () {
        const result = yield* deepagentCode.run("finish the goal", {
          agent: "loop",
          extraArgs: ["--goal", "--continue"],
        })
        expect(result.exitCode).not.toBe(0)
        expect(`${result.stdout}\n${result.stderr}`).toContain("--goal starts a fresh loop session")
      }),
    30_000,
  )

  cliIt.live(
    "runs a scriptable goal through the production Goal lifecycle and orders JSON events",
    ({ llm, deepagentCode }) =>
      Effect.gen(function* () {
        const objective = "Complete the deterministic CLI goal"
        yield* llm.toolFrom(completeCurrentPlan)
        yield* llm.text("Goal step completed")

        const result = yield* deepagentCode.run(objective, {
          agent: "loop",
          format: "json",
          extraArgs: ["--goal"],
          env: goalEnvironment,
          timeoutMs: 30_000,
        })
        deepagentCode.expectExit(result, 0)

        const events = deepagentCode.parseJsonEvents(result.stdout)
        const start = events.findIndex((event) => event.type === "goal_start")
        const running = events.findIndex(
          (event) =>
            event.type === "goal" &&
            typeof event.goal === "object" &&
            event.goal !== null &&
            "phase" in event.goal &&
            event.goal.phase === "running",
        )
        const done = events.findIndex(
          (event) =>
            event.type === "goal" &&
            typeof event.goal === "object" &&
            event.goal !== null &&
            "phase" in event.goal &&
            event.goal.phase === "done",
        )
        const terminal = events.findIndex((event) => event.type === "session_terminal" && event.phase === "done")

        expect(start).toBeGreaterThanOrEqual(0)
        expect(running).toBeGreaterThan(start)
        expect(done).toBeGreaterThan(running)
        expect(terminal).toBeGreaterThan(done)
        expect(events.some((event) => event.type === "permission" || event.type === "question")).toBe(false)
        expect(yield* llm.pending).toBe(0)
        expect(yield* llm.misses).toEqual([])
      }),
    60_000,
  )

  cliIt.live(
    "reads goal+plan.md when the scriptable goal has no message",
    ({ llm, home, deepagentCode }) =>
      Effect.gen(function* () {
        const objective = "Complete the plan-file CLI goal"
        yield* Effect.promise(() => mkdir(path.join(home, ".deepagent-code/plans"), { recursive: true }))
        yield* Effect.promise(() =>
          Bun.write(
            path.join(home, ".deepagent-code/plans/goal+plan.md"),
            ["## Goal", objective, "", "## Criteria", "- plan complete", "", "## Plan", `- [>] ${objective}`, ""].join(
              "\n",
            ),
          ),
        )
        yield* llm.toolFrom(completeCurrentPlan)
        yield* llm.text("Plan-file goal completed")

        const result = yield* deepagentCode.spawn(
          ["run", "--goal", "--agent", "loop", "--model", "test/test-model", "--format", "json"],
          { env: goalEnvironment, timeoutMs: 30_000 },
        )
        deepagentCode.expectExit(result, 0)
        const events = deepagentCode.parseJsonEvents(result.stdout)
        expect(events.some((event) => event.type === "goal_start")).toBe(true)
        expect(events.some((event) => event.type === "session_terminal" && event.phase === "done")).toBe(true)
      }),
    60_000,
  )

  cliIt.live(
    "returns nonzero when a goal-worker provider turn fails",
    ({ llm, deepagentCode }) =>
      Effect.gen(function* () {
        yield* llm.fail("goal worker provider failure")
        const result = yield* deepagentCode.run("Exercise the Goal failure path", {
          agent: "loop",
          format: "json",
          extraArgs: ["--goal"],
          env: goalEnvironment,
          timeoutMs: 30_000,
        })
        expect(result.exitCode).not.toBe(0)
        const events = deepagentCode.parseJsonEvents(result.stdout)
        expect(
          events.some(
            (event) =>
              event.type === "session_terminal" && ["rolled_back", "needs_human"].includes(String(event.phase)),
          ),
        ).toBe(true)
      }),
    60_000,
  )
})
