import { afterEach, expect, test } from "bun:test"
import { createOpencodeClient } from "@deepagent-code/sdk"
import { GoalClient } from "@deepagent-code/core/deepagent/goal-client"
import { createGoalCommands } from "../../src/component/prompt/goal-command"

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
const servers: ReturnType<typeof Bun.serve>[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})
function fixture() {
  const state = {
    goal: snapshot(),
    code: 0,
    drop: false,
    writes: 0,
    reads: 0,
    delay: undefined as Promise<void> | undefined,
    readFailure: false,
    bodies: [] as GoalClient.ControlInput[],
    receipts: new Map<string, GoalClient.Snapshot>(),
    headers: [] as (string | null)[],
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      state.headers.push(
        new URL(request.url).searchParams.get("directory") ??
          decodeURIComponent(request.headers.get("x-deepagent-code-directory") ?? ""),
      )
      if (request.method === "GET") {
        state.reads++
        if (state.readFailure)
          return Response.json({ code: "unavailable", message: "status unavailable" }, { status: 503 })
        await state.delay
        return Response.json({ goal: state.goal })
      }
      const body = (await request.json()) as GoalClient.ControlInput
      state.bodies.push(body)
      if (state.code)
        return Response.json(
          {
            code: state.code === 409 ? "revision_conflict" : state.code === 400 ? "invalid_request" : "unavailable",
            message: "controlled rejection",
          },
          { status: state.code },
        )
      const prior = state.receipts.get(body.requestID)
      if (prior) return Response.json({ ...prior, replayed: true })
      state.writes++
      state.goal = snapshot({ revision: 2, requestedPhase: "paused", phase: "paused", inFlight: true })
      state.receipts.set(body.requestID, state.goal)
      if (state.drop) {
        state.drop = false
        server.timeout(request, 0)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("lost acknowledgement"))
            },
          }),
        )
      }
      return Response.json(state.goal)
    },
  })
  servers.push(server)
  const client = createOpencodeClient({
    baseUrl: server.url.toString(),
    directory: "/private/projects/goal-a",
    throwOnError: true,
  }) as unknown as GoalClient.Client
  return {
    state,
    client,
    scope: { server: server.url.toString(), directory: "/private/projects/goal-a", sessionID: "session-a" },
  }
}

test("real SDK HTTP commands bind observed Goal/revision, use actual directory, and never treat requested pause as stopped", async () => {
  const f = fixture()
  const value = await createGoalCommands().run({ ...f, command: "pause", current: () => true })
  expect(f.state.reads).toBe(1)
  expect(f.state.bodies).toEqual([
    { sessionID: "session-a", goalId: "goal-a", expectedRevision: 1, requestID: value.request.body.requestID },
  ])
  expect(f.state.headers).toEqual(["/private/projects/goal-a", "/private/projects/goal-a"])
  expect(GoalClient.confirmedTerminal(value.snapshot)).toBe(false)
  expect(GoalClient.canControl(value.snapshot, "resume")).toBe(false)
})

for (const code of [400, 409, 503])
  test(`actual ${code} SDK error is not mistaken for an acknowledgement or auto-retargeted`, async () => {
    const f = fixture()
    f.state.code = code
    const commands = createGoalCommands()
    const error = await commands.run({ ...f, command: "pause", current: () => true }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(GoalClient.RequestError)
    expect((error as GoalClient.RequestError).status).toBe(code)
    expect((error as GoalClient.RequestError).unknownOutcome).toBe(code === 503)
    expect(f.state.bodies).toHaveLength(1)
    expect(f.state.writes).toBe(0)
  })

test("lost HTTP acknowledgement retains exact body/client/request and only explicit retry reconciles once", async () => {
  const f = fixture()
  f.state.drop = true
  const commands = createGoalCommands()
  const error = await commands.run({ ...f, command: "pause", current: () => true }).catch((error: unknown) => error)
  expect(error).toBeInstanceOf(GoalClient.RequestError)
  expect((error as GoalClient.RequestError).unknownOutcome).toBe(true)
  expect(f.state.bodies).toHaveLength(1)
  await expect(commands.run({ ...f, command: "stop", current: () => true })).rejects.toThrow("/goal retry")
  const value = await commands.run({ ...f, command: "retry", current: () => true })
  expect(value.snapshot.replayed).toBe(true)
  expect(f.state.bodies).toHaveLength(2)
  expect(f.state.bodies[0]).toEqual(f.state.bodies[1])
  expect(f.state.writes).toBe(1)
  expect(f.state.reads).toBe(1)
})

test("leaving target while GET is pending prevents the POST", async () => {
  const f = fixture()
  const release = Promise.withResolvers<void>()
  f.state.delay = release.promise
  let current = true
  const operation = createGoalCommands().run({ ...f, command: "pause", current: () => current })
  while (f.state.reads === 0) await Bun.sleep(1)
  current = false
  release.resolve()
  await expect(operation).rejects.toThrow("target changed")
  expect(f.state.bodies).toHaveLength(0)
})

for (const patch of [
  { revision: 0 },
  { recoveryRequired: true },
  { preparation: "preparing" as const },
  { requestedPhase: "paused" as const, inFlight: true },
])
  test(`readonly/recovery/busy snapshot does not resume: ${JSON.stringify(patch)}`, async () => {
    const f = fixture()
    f.state.goal = snapshot(patch)
    await expect(createGoalCommands().run({ ...f, command: "resume", current: () => true })).rejects.toThrow(
      "unavailable",
    )
    expect(f.state.bodies).toHaveLength(0)
  })

test("wrong-target acknowledgement stays unknown and snapshots require new control fields", async () => {
  const client = { client: { request: async <T>() => ({ data: snapshot({ goalId: "wrong" }) as T }) } }
  const request = GoalClient.capture(client, { server: "a", directory: "a", sessionID: "a" }, "stop", {
    sessionID: "a",
    goalId: "right",
    expectedRevision: 1,
    requestID: "request",
  })
  const error = await GoalClient.send(request).catch((error: unknown) => error)
  expect((error as GoalClient.RequestError).unknownOutcome).toBe(true)
  await expect(
    GoalClient.status(
      { client: { request: async <T>() => ({ data: { goal: { goalId: "old", phase: "stopped" } } as T }) } },
      "a",
    ),
  ).rejects.toThrow("unsupported control contract")
})

test("503 while only reading status has no mutation outcome and creates no retry descriptor", async () => {
  const f = fixture()
  f.state.readFailure = true
  const commands = createGoalCommands()
  const error = await commands.run({ ...f, command: "pause", current: () => true }).catch((error: unknown) => error)
  expect(error).toBeInstanceOf(GoalClient.RequestError)
  expect((error as GoalClient.RequestError).status).toBe(503)
  expect((error as GoalClient.RequestError).unknownOutcome).toBe(false)
  expect(f.state.bodies).toHaveLength(0)
  await expect(commands.run({ ...f, command: "retry", current: () => true })).rejects.toThrow("No unconfirmed")
})
