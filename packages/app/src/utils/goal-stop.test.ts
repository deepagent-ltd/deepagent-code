import { afterEach, expect, test } from "bun:test"
import { createOpencodeClient } from "@deepagent-code/sdk"
import { GoalClient } from "@deepagent-code/core/deepagent/goal-client"
import { createGoalStop } from "./goal-stop"

const servers: ReturnType<typeof Bun.serve>[] = []
afterEach(() => servers.splice(0).forEach((server) => server.stop(true)))
const snapshot = (patch: Partial<GoalClient.Snapshot> = {}): GoalClient.Snapshot => ({
  goalId: "goal-a",
  planDocId: "plan-a",
  phase: "running",
  running: true,
  revision: 1,
  requestedPhase: "running",
  preparation: "ready",
  inFlight: false,
  recoveryRequired: false,
  wakeState: "published",
  replayed: false,
  ...patch,
})
function fixture() {
  const state = {
    reads: 0,
    posts: [] as GoalClient.ControlInput[],
    fail: false,
    current: true,
    goal: snapshot(),
    waiting: undefined as Promise<void> | undefined,
  }
  const headers = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-deepagent-code-directory",
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "OPTIONS") return new Response(null, { headers })
      if (request.method === "GET") {
        state.reads++
        await state.waiting
        return Response.json({ goal: state.goal }, { headers })
      }
      state.posts.push(await request.json())
      state.goal = snapshot({ requestedPhase: "paused", phase: "paused", inFlight: true, revision: 2 })
      if (state.fail) {
        state.fail = false
        return Response.json({ code: "unavailable", message: "lost reply" }, { status: 503, headers })
      }
      return Response.json(state.goal, { headers })
    },
  })
  servers.push(server)
  const client = createOpencodeClient({ baseUrl: server.url.href }) as unknown as GoalClient.Client
  const input = {
    client,
    scope: { server: server.url.href, directory: "/project", sessionID: "session-a" },
    goalID: "goal-a",
    current: () => state.current,
  }
  return { state, input, stop: createGoalStop() }
}

test("composer stop pauses its exact Goal and leaves in-flight fact visible", async () => {
  const f = fixture()
  const result = await f.stop(f.input)
  expect(f.state.posts).toHaveLength(1)
  expect(f.state.posts[0]).toMatchObject({ sessionID: "session-a", goalId: "goal-a", expectedRevision: 1 })
  expect(result.requestedPhase).toBe("paused")
  expect(result.inFlight).toBe(true)
})

test("unknown pause retries the original descriptor without rebinding to a later revision", async () => {
  const f = fixture()
  f.state.fail = true
  await expect(f.stop(f.input)).rejects.toMatchObject({ unknownOutcome: true })
  await f.stop(f.input)
  expect(f.state.posts).toHaveLength(2)
  expect(f.state.posts[1]).toEqual(f.state.posts[0])
  expect(f.state.reads).toBe(1)
})

test("a late status read cannot dispatch a control after the view retires", async () => {
  const f = fixture()
  const wait = Promise.withResolvers<void>()
  f.state.waiting = wait.promise
  const result = f.stop(f.input)
  await new Promise((resolve) => setTimeout(resolve, 5))
  f.state.current = false
  wait.resolve()
  await expect(result).rejects.toMatchObject({ code: "target_conflict" })
  expect(f.state.posts).toHaveLength(0)
})
