import { expect } from "bun:test"
import { Effect } from "effect"
import { createServer, type ServerResponse } from "node:http"
import { GoalClient } from "@deepagent-code/core/deepagent/goal-client"
import { cliIt } from "../lib/cli-process"

const running: GoalClient.Snapshot = {
  goalId: "goal_cli_contract",
  planDocId: "plan_cli_contract",
  phase: "running",
  running: true,
  revision: 4,
  requestedPhase: "running",
  preparation: "ready",
  inFlight: false,
  recoveryRequired: false,
  wakeState: "published",
  replayed: false,
}

// A real loopback HTTP protocol fixture and real CLI/SDK subprocess. Its controlled responses
// exercise client uncertainty/old-event handling; it is not a claim of backend Goal execution.
function endpoint(
  handle: (request: { path: string; method: string; body: Record<string, unknown> }, response: ServerResponse) => void,
) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const text = Buffer.concat(chunks).toString()
        handle(
          {
            path: new URL(request.url!, "http://localhost").pathname,
            method: request.method!,
            body: text ? JSON.parse(text) : {},
          },
          response,
        )
      })
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Missing loopback endpoint")
      return { server, url: `http://127.0.0.1:${address.port}` }
    }),
    ({ server }) =>
      Effect.promise(async () => {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) =>
          server.close((error) =>
            error && !("code" in error && error.code === "ERR_SERVER_NOT_RUNNING") ? reject(error) : resolve(),
          ),
        )
      }),
  )
}

function reply(response: ServerResponse, data: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(data))
}

cliIt.live(
  "Goal control preserves one captured request across unknown outcome and explicit retry",
  ({ deepagentCode, llm }) =>
    Effect.gen(function* () {
      const requests: Record<string, unknown>[] = []
      const reads: string[] = []
      const server = yield* endpoint((request, response) => {
        if (request.path === "/deepagent/goal/status") {
          reads.push(request.path)
          return reply(response, { goal: running })
        }
        if (request.path === "/deepagent/goal/stop") {
          requests.push(request.body)
          if (requests.length === 1)
            return reply(response, { code: "unavailable", message: "receipt response unavailable" }, 503)
          return reply(response, { ...running, revision: 5, requestedPhase: "stopped", inFlight: true, replayed: true })
        }
        reply(response, { message: request.path }, 404)
      })
      const first = yield* deepagentCode.spawn([
        "goal",
        "stop",
        "ses_cli_unknown",
        "--attach",
        server.url,
        "--format",
        "json",
      ])
      expect(first.termination).toBe("exited")
      expect(first.exitCode).toBe(1)
      const unknown = deepagentCode.expectJsonStdout(first) as {
        outcome: string
        request: { requestID: string; goalId: string; expectedRevision: number }
      }
      expect(unknown.outcome).toBe("unknown")
      expect(unknown.request).toMatchObject({ goalId: running.goalId, expectedRevision: 4 })
      expect(first.stderr).toContain(unknown.request.requestID)
      const second = yield* deepagentCode.spawn([
        "goal",
        "stop",
        "ses_cli_unknown",
        "--attach",
        server.url,
        "--format",
        "json",
        "--request-id",
        unknown.request.requestID,
        "--goal-id",
        unknown.request.goalId,
        "--expected-revision",
        String(unknown.request.expectedRevision),
      ])
      deepagentCode.expectExit(second, 0)
      expect(deepagentCode.expectJsonStdout(second)).toMatchObject({
        outcome: "accepted",
        terminalConfirmed: false,
        goal: { inFlight: true, requestedPhase: "stopped", replayed: true },
      })
      expect(requests).toHaveLength(2)
      expect(requests[1]).toEqual(requests[0])
      expect(reads).toHaveLength(1)
      expect(second.stderr).not.toContain("Stopped goal")
      expect(yield* llm.hits).toHaveLength(0)
    }),
  90000,
)

cliIt.live(
  "Goal conflict refreshes read-only without retargeting and rejects incomplete retry flags",
  ({ deepagentCode }) =>
    Effect.gen(function* () {
      const state = { reads: 0, posts: 0 }
      const server = yield* endpoint((request, response) => {
        if (request.path === "/deepagent/goal/status")
          return reply(response, { goal: ++state.reads === 1 ? running : { ...running, goalId: "goal_newer" } })
        if (request.path === "/deepagent/goal/pause") {
          state.posts++
          expect(request.body).toMatchObject({ goalId: running.goalId, expectedRevision: 4 })
          return reply(response, { code: "revision_conflict", message: "revision changed" }, 409)
        }
        reply(response, {}, 404)
      })
      const first = yield* deepagentCode.spawn([
        "goal",
        "pause",
        "ses_cli_conflict",
        "--attach",
        server.url,
        "--format",
        "json",
      ])
      expect(first.exitCode).toBe(1)
      expect(deepagentCode.expectJsonStdout(first)).toMatchObject({
        outcome: "rejected",
        latest: { goal: { goalId: "goal_newer" } },
      })
      expect(state).toEqual({ reads: 2, posts: 1 })
      const invalid = yield* deepagentCode.spawn([
        "goal",
        "pause",
        "ses_cli_conflict",
        "--attach",
        server.url,
        "--request-id",
        "partial",
      ])
      expect(invalid.exitCode).toBe(1)
      expect(invalid.stderr).toContain("Exact retry requires")
      expect(state).toEqual({ reads: 2, posts: 1 })
    }),
  90000,
)

cliIt.live(
  "Goal run ignores old stopped events and waits for complete status without in-flight work",
  ({ deepagentCode, home, llm }) =>
    Effect.gen(function* () {
      const state = {
        reads: 0,
        creates: 0,
        body: {} as Record<string, unknown>,
        stream: undefined as ServerResponse | undefined,
      }
      const server = yield* endpoint((request, response) => {
        if (request.path === "/event") {
          state.stream = response
          response.writeHead(200, { "content-type": "text/event-stream" })
          response.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`)
          return
        }
        if (request.path === "/session" && request.method === "POST") {
          state.creates++
          return reply(response, { id: "ses_cli_observe", title: "fixture", directory: home })
        }
        if (request.path === "/agent") return reply(response, [{ name: "loop", mode: "primary" }])
        if (request.path === "/deepagent/goal/start") {
          state.body = request.body
          state.stream?.write(
            `data: ${JSON.stringify({ type: "goal.updated", properties: { sessionID: "ses_cli_observe", goalId: running.goalId, phase: "stopped", running: false } })}\n\n`,
          )
          return reply(response, running)
        }
        if (request.path === "/deepagent/goal/status")
          return reply(response, {
            goal:
              ++state.reads === 1
                ? { ...running, phase: "stopped", requestedPhase: "stopped", inFlight: true }
                : { ...running, phase: "done", requestedPhase: "done", running: false },
          })
        reply(response, {}, 404)
      })
      const result = yield* deepagentCode.run("observe the existing task", {
        agent: "loop",
        format: "json",
        extraArgs: ["--goal", "--attach", server.url, "--dir", home],
        env: { DEEPAGENT_CODE_RUN_TIMEOUT_MS: "10000" },
        timeoutMs: 30000,
      })
      deepagentCode.expectExit(result, 0)
      const events = deepagentCode.parseJsonEvents(result.stdout)
      expect(state.creates).toBe(1)
      expect(state.reads).toBeGreaterThanOrEqual(2)
      expect(state.body).toMatchObject({ sessionID: "ses_cli_observe", objective: "observe the existing task" })
      expect(typeof state.body.requestID).toBe("string")
      expect(events.filter((event) => event.type === "session_terminal")).toEqual([
        expect.objectContaining({ phase: "done" }),
      ])
      expect(events.find((event) => event.type === "goal_request")).toMatchObject({ request: state.body })
      expect(yield* llm.hits).toHaveLength(0)
    }),
  60000,
)

cliIt.live(
  "Goal run retries an unknown start only in the same Session with the original request and payload",
  ({ deepagentCode, home }) =>
    Effect.gen(function* () {
      const requests: Record<string, unknown>[] = []
      const state = { creates: 0, reads: 0 }
      const server = yield* endpoint((request, response) => {
        if (request.path === "/event") {
          response.writeHead(200, { "content-type": "text/event-stream" })
          response.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`)
          return
        }
        if (request.path === "/session" && request.method === "POST") {
          state.creates++
          return reply(response, { id: "ses_cli_retry", directory: home })
        }
        if (request.path === "/session/ses_cli_retry") return reply(response, { id: "ses_cli_retry", directory: home })
        if (request.path === "/agent") return reply(response, [{ name: "loop", mode: "primary" }])
        if (request.path === "/deepagent/goal/start") {
          requests.push(request.body)
          if (requests.length === 1) return reply(response, { code: "unavailable", message: "response lost" }, 503)
          if (requests.length === 3)
            return reply(response, { code: "request_conflict", message: "changed payload" }, 409)
          return reply(response, { ...running, replayed: true })
        }
        if (request.path === "/deepagent/goal/status") {
          state.reads++
          return reply(response, { goal: { ...running, phase: "done", requestedPhase: "done", running: false } })
        }
        reply(response, {}, 404)
      })
      const initial = yield* deepagentCode.run("exact start", {
        agent: "loop",
        format: "json",
        extraArgs: ["--goal", "--attach", server.url, "--dir", home],
      })
      expect(initial.exitCode).toBe(1)
      const first = deepagentCode.parseJsonEvents(initial.stdout)
      expect(first.find((event) => event.type === "error")).toMatchObject({ outcome: "unknown" })
      expect(requests).toHaveLength(1)
      const retry = yield* deepagentCode.run("exact start", {
        agent: "loop",
        format: "json",
        extraArgs: [
          "--goal",
          "--attach",
          server.url,
          "--dir",
          home,
          "--session",
          "ses_cli_retry",
          "--request-id",
          String(requests[0]!.requestID),
        ],
      })
      deepagentCode.expectExit(retry, 0)
      expect(requests).toHaveLength(2)
      expect(requests[1]).toEqual(requests[0])
      expect(state.creates).toBe(1)
      const conflict = yield* deepagentCode.run("changed start", {
        agent: "loop",
        format: "json",
        extraArgs: [
          "--goal",
          "--attach",
          server.url,
          "--dir",
          home,
          "--session",
          "ses_cli_retry",
          "--request-id",
          String(requests[0]!.requestID),
        ],
      })
      expect(conflict.exitCode).toBe(1)
      expect(deepagentCode.parseJsonEvents(conflict.stdout).find((event) => event.type === "error")).toMatchObject({
        outcome: "rejected",
        latest: { goal: { goalId: running.goalId } },
      })
      expect(requests).toHaveLength(3)
      expect(state).toEqual({ creates: 1, reads: 2 })
    }),
  90000,
)

cliIt.live(
  "Goal run reports recovery and bounded observation without claiming a stop",
  ({ deepagentCode, home }) =>
    Effect.gen(function* () {
      const state = { mode: "recovery", controls: 0 }
      const server = yield* endpoint((request, response) => {
        if (request.path === "/event") {
          response.writeHead(200, { "content-type": "text/event-stream" })
          response.write(
            `data: ${JSON.stringify({ type: "goal.updated", properties: { sessionID: "ses_cli_pending", goalId: running.goalId, phase: "stopped", running: false } })}\n\n`,
          )
          return
        }
        if (request.path === "/session") return reply(response, { id: "ses_cli_pending", directory: home })
        if (request.path === "/agent") return reply(response, [{ name: "loop", mode: "primary" }])
        if (request.path === "/deepagent/goal/start") return reply(response, running)
        if (request.path === "/deepagent/goal/status" && state.mode === "unavailable")
          return reply(response, { code: "unavailable", message: "status offline" }, 503)
        if (request.path === "/deepagent/goal/status")
          return reply(response, {
            goal: {
              ...running,
              phase: "stopped",
              requestedPhase: "stopped",
              inFlight: true,
              recoveryRequired: state.mode === "recovery",
            },
          })
        if (request.path.startsWith("/deepagent/goal/")) state.controls++
        reply(response, {}, 404)
      })
      const recovery = yield* deepagentCode.run("pending task", {
        agent: "loop",
        format: "json",
        extraArgs: ["--goal", "--attach", server.url, "--dir", home],
      })
      expect(recovery.exitCode).toBe(1)
      expect(recovery.termination).toBe("exited")
      const events = deepagentCode.parseJsonEvents(recovery.stdout)
      expect(events.find((event) => event.type === "goal_recovery")).toMatchObject({
        stopped: false,
        goal: { inFlight: true },
      })
      expect(events.some((event) => event.type === "session_terminal")).toBe(false)
      state.mode = "pending"
      const timed = yield* deepagentCode.run("pending task", {
        agent: "loop",
        format: "json",
        extraArgs: ["--goal", "--attach", server.url, "--dir", home],
        env: { DEEPAGENT_CODE_RUN_TIMEOUT_MS: "1200" },
        timeoutMs: 15000,
      })
      expect(timed.exitCode).toBe(1)
      expect(timed.termination).toBe("exited")
      const bounded = deepagentCode.parseJsonEvents(timed.stdout)
      expect(bounded.some((event) => event.type === "session_terminal")).toBe(false)
      expect(bounded.find((event) => event.type === "error")?.error).toContain("without cancelling or confirming")
      expect(state.controls).toBe(0)
      state.mode = "unavailable"
      const unavailable = yield* deepagentCode.run("pending task", {
        agent: "loop",
        format: "json",
        extraArgs: ["--goal", "--attach", server.url, "--dir", home],
      })
      expect(unavailable.exitCode).toBe(1)
      expect(unavailable.termination).toBe("exited")
      const lost = deepagentCode.parseJsonEvents(unavailable.stdout)
      expect(lost.find((event) => event.type === "error")).toMatchObject({ stopped: false, goalId: running.goalId })
      expect(lost.some((event) => event.type === "session_terminal")).toBe(false)
      expect(state.controls).toBe(0)
    }),
  90000,
)
