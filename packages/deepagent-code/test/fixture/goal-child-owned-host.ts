// Actual AppRuntime/Location/main-runner oracle. Only HTTP model responses are deterministic;
// DEV_MINT is private fixture authority, not release qualification or a production Goal caller.
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createServer } from "node:http"
import net from "node:net"
import { Cause, Effect, Exit } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { GoalChild } from "@deepagent-code/core/deepagent/goal-child"
import { GoalChildExecution } from "@deepagent-code/core/deepagent/goal-child-execution"
import { GoalControl } from "@deepagent-code/core/deepagent/goal-control"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { ModelV2 } from "@deepagent-code/core/model"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { GoalControlFixture } from "../../../core/test/fixture/goal-control"
import { WorkAuthorityFixture } from "../../../core/test/fixture/work-authority"
import { AppRuntime } from "@/effect/app-runtime"
import { Server } from "@/server/server"

const root = process.argv[2]!
const scenario = process.argv[3]!
const phase = process.argv[4] ?? "live"
const directory = path.join(root, "project")
const requests: unknown[] = []
let cancel: (() => Promise<void>) | undefined
const provider = createServer(async (request, response) => {
  assert.equal(request.url, "/v1/chat/completions")
  const parts: Buffer[] = []
  for await (const part of request) parts.push(Buffer.from(part))
  requests.push(JSON.parse(Buffer.concat(parts).toString()))
  await Bun.write(path.join(root, `${phase}-provider.json`), JSON.stringify(requests, null, 2))
  response.writeHead(200, { "content-type": "text/event-stream" })
  const emit = (value: unknown) =>
    response.write(
      `data: ${JSON.stringify({ id: "chatcmpl-owned", object: "chat.completion.chunk", created: 1, model: "test-model", ...Object(value) })}\n\n`,
    )
  emit({ choices: [{ index: 0, delta: { role: "assistant" } }] })
  if (scenario === "kill" || scenario === "interrupt") return
  if (scenario === "pause-tool") await cancel!()
  const tool = ["permission", "pause-tool", "pause-body", "tool-success"].includes(scenario)
  emit({
    choices: [
      {
        index: 0,
        delta:
          tool && requests.length === 1
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_owned",
                    type: "function",
                    function: {
                      name: "bash",
                      arguments: JSON.stringify({
                        command: `printf executed > '${path.join(root, "executed")}'`,
                        description: "Controlled local marker",
                      }),
                    },
                  },
                ],
              }
            : { content: "Owned Goal child completed" },
      },
    ],
  })
  emit({
    choices: [{ index: 0, delta: {}, finish_reason: tool && requests.length === 1 ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  })
  response.end("data: [DONE]\n\n")
})
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve))
const address = provider.address()
assert(address && typeof address !== "string")
await Bun.write(
  path.join(directory, "deepagent-code.json"),
  JSON.stringify({
    formatter: false,
    lsp: false,
    model: "fixture/test-model",
    permission: { "*": "allow", bash: scenario === "permission" ? "ask" : "allow" },
    provider: {
      fixture: {
        name: "Owned fixture",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        options: { apiKey: "private-fixture", baseURL: `http://127.0.0.1:${address.port}/v1` },
        models: {
          "test-model": {
            name: "Fixture",
            tool_call: true,
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
          },
        },
      },
    },
  }),
)
const rg = Bun.which(process.platform === "win32" ? "rg.exe" : "rg")
assert(rg)
const bin = path.join(root, "home/.deepagent/code/cache/bin")
await fs.mkdir(bin, { recursive: true })
await fs.copyFile(rg, path.join(bin, path.basename(rg)))

const facts = () =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      return {
        units: yield* db.all<Record<string, unknown>>("SELECT * FROM goal_child_unit"),
        sessions: yield* db.all<Record<string, unknown>>("SELECT id,execution_claim_token FROM session ORDER BY id"),
        inputs: yield* db.all<Record<string, unknown>>("SELECT * FROM session_input"),
        activities: yield* db.all<Record<string, unknown>>("SELECT * FROM session_activity"),
        receipts: yield* db.all<Record<string, unknown>>("SELECT * FROM session_v2_provider_turn_receipt"),
        tools: yield* db.all<Record<string, unknown>>("SELECT * FROM session_v2_tool_effect_admission"),
        effects: yield* db.all<Record<string, unknown>>("SELECT * FROM session_v2_tool_effect"),
      }
    }),
  )
const wait = async <A>(read: () => Promise<A | undefined>) => {
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Owned fixture observation timeout")
}
let listener: Awaited<ReturnType<typeof Server.listen>> | undefined
try {
  if (phase === "live") await AppRuntime.runPromise(WorkAuthorityFixture.initialize())
  await AppRuntime.runPromise(Database.Service)
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
  const address = probe.address()
  assert(address && typeof address !== "string")
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  // The production route graph captures the shared root's runtime-integrity identity.
  listener = await Server.listen({ hostname: "127.0.0.1", port: address.port })
  const context =
    phase === "live"
      ? await AppRuntime.runPromise(
          Effect.gen(function* () {
            const db = (yield* Database.Service).db
            const sessions = yield* SessionV2.Service
            const parent = yield* sessions.create({
              location: { directory: AbsolutePath.make(directory) },
              model: { providerID: ProviderV2.ID.make("fixture"), id: ModelV2.ID.make("test-model") },
              permissions: [
                { action: "*", resource: "*", effect: "allow" },
                ...(scenario === "permission" ? [{ action: "bash", resource: "*", effect: "ask" as const }] : []),
              ],
            })
            const input = {
              sessionID: parent.id,
              requestID: "owned-start",
              requestHash: GoalControl.fingerprint(parent.id),
              planDocId: "plan-goal",
              initialization: {
                ...GoalControlFixture.initialization,
                model: { providerID: "fixture", modelID: "test-model" },
              },
              driverMode: "event" as const,
            }
            const goal = yield* GoalControl.reserveStart(db, input)
            yield* GoalControl.activate(db, { ...input, goalId: goal.row.goal_id })
            const tick = yield* GoalControl.beginTick(db, {
              sessionID: parent.id,
              goalId: goal.row.goal_id,
              planDocId: "plan-goal",
              revision: 1,
              seq: 0,
              expectedPlanVersion: 1,
              mode: "event",
            })
            const child = yield* GoalChild.admit(db, sessions, {
              permitID: tick.permit.permit_id,
              permitToken: tick.permit.token,
              roleKey: "worker.0",
              agent: scenario === "alias-agent" ? "build" : "auto",
              mode: "plain",
              stage: "plain",
              text: "Perform the deterministic local fixture task.",
              steeringHash: "b".repeat(64),
              promptPolicyHash: "c".repeat(64),
            })
            return {
              parentID: parent.id,
              goalID: goal.row.goal_id,
              sessionID: child.admitted.sessionID,
              target: GoalChildExecution.target(child.unit),
              location: parent.location,
            }
          }),
        )
      : await Bun.file(path.join(root, "context.json")).json()
  if (phase === "live") await Bun.write(path.join(root, "context.json"), JSON.stringify(context))
  const execution = await AppRuntime.runPromise(SessionExecution.Service)
  const owned = await AppRuntime.runPromise(SessionExecution.requireOwned(execution))
  cancel = () =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        return yield* GoalControl.control((yield* Database.Service).db, {
          sessionID: context.parentID,
          goalId: context.goalID,
          expectedRevision: 1,
          requestID: "pause-owned",
          action: scenario === "interrupt" ? "stop" : "pause",
        })
      }),
    ).then(() => undefined)
  if (phase === "cold") {
    const before = await facts()
    const resumed = await AppRuntime.runPromise(execution.resume(context.sessionID).pipe(Effect.exit))
    await AppRuntime.runPromise(execution.wake(context.sessionID))
    const rerun = await AppRuntime.runPromise(owned.run(context.target).pipe(Effect.exit))
    assert(Exit.isFailure(resumed) && Exit.isFailure(rerun))
    assert.deepEqual(await facts(), before)
    assert.equal(requests.length, 0)
    await Bun.write(
      path.join(root, "cold-result.json"),
      JSON.stringify(
        {
          pid: process.pid,
          before,
          after: await facts(),
          requests,
          resumed: Cause.pretty(resumed.cause),
          rerun: Cause.pretty(rerun.cause),
        },
        null,
        2,
      ),
    )
  } else {
    if (scenario === "pause-seal" || scenario === "pause-body") {
      await AppRuntime.runPromise(
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          // Actual SQL transition races current control at the last seal / pre-body boundary.
          yield* db
            .run(
              `CREATE TRIGGER revoke_owned_control AFTER INSERT ON ${scenario === "pause-seal" ? "session_v2_provider_turn_receipt" : "session_v2_tool_effect_admission"}
          BEGIN UPDATE goal_control SET requested_phase='paused',revision=revision+1 WHERE goal_id='${context.goalID}'; END`,
            )
            .pipe(Effect.orDie)
        }),
      )
    }
    const run = await AppRuntime.runPromise(owned.run(context.target))
    assert.equal(run.status, "started")
    if (run.status !== "started") throw new Error(run.status)
    if (scenario === "kill") {
      await wait(async () => (requests.length === 1 ? true : undefined))
      await Bun.write(
        path.join(root, "kill-ready.json"),
        JSON.stringify({ pid: process.pid, facts: await facts() }, null, 2),
      )
      await new Promise(() => {})
    }
    if (scenario === "interrupt") {
      await wait(async () => (requests.length === 1 ? true : undefined))
      await cancel()
      const interrupted = await AppRuntime.runPromise(owned.interrupt(run.receipt, () => true))
      assert.equal(interrupted.status, "matched")
    }
    if (scenario === "permission") {
      const permissions = await wait(async () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const locations = yield* LocationServiceMap
            const list = yield* PermissionV2.Service.use((service) => service.forSession(context.sessionID)).pipe(
              Effect.provide(locations.get(context.location)),
            )
            return list.length ? list : undefined
          }),
        ),
      )
      const ordinary = await AppRuntime.runPromise(execution.resume(context.sessionID).pipe(Effect.exit))
      assert(Exit.isFailure(ordinary))
      await AppRuntime.runPromise(execution.wake(context.sessionID))
      const joined = await AppRuntime.runPromise(owned.run(context.target, { receipt: run.receipt }))
      assert.equal(joined.status, "joined")
      await cancel()
      await AppRuntime.runPromise(
        Effect.gen(function* () {
          const locations = yield* LocationServiceMap
          yield* PermissionV2.Service.use((service) =>
            service.reply({ requestID: permissions[0].id, reply: "once" }),
          ).pipe(Effect.provide(locations.get(context.location)))
        }),
      )
    }
    const done = await AppRuntime.runPromise(owned.await(run.receipt))
    assert.equal(done.status, "settled")
    const result = {
      pid: process.pid,
      requests,
      exit: done.exit._tag,
      ...(Exit.isFailure(done.exit) ? { cause: Cause.pretty(done.exit.cause) } : {}),
      facts: await facts(),
      marker: await Bun.file(path.join(root, "executed")).exists(),
    }
    await Bun.write(path.join(root, "result.json"), JSON.stringify(result, null, 2))
    assert.equal(
      requests.length,
      ["alias-agent", "pause-seal"].includes(scenario) ? 0 : scenario === "tool-success" ? 2 : 1,
      JSON.stringify(result),
    )
    assert.equal(result.marker, scenario === "tool-success")
    assert.equal(
      done.exit._tag,
      ["complete", "tool-success"].includes(scenario) ? "Success" : "Failure",
      JSON.stringify(result),
    )
  }
} finally {
  provider.closeAllConnections()
  await new Promise<void>((resolve) => provider.close(() => resolve()))
  await listener?.stop(true)
  await Server.disposeDefault()
  await AppRuntime.dispose()
}
process.exit(0)
