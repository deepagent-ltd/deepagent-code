import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const scenarios = [
  "lifecycle",
  "refresh ordering",
  "name collision",
  "task required",
  "structured deduplication",
  "reconfigure handshake",
  "disconnect during handshake",
  "competing replacement handshakes",
  "invalid output schema",
] as const
const childScenario = process.env.DEEPAGENT_TEST_MCP_WIRE_CHILD

// Existing MCP unit tests replace modules process-wide. Real SDK/transport authorities must
// load in a clean process, including when this file is selected by the whole package suite.
if (!childScenario) {
  test.each([...scenarios])(
    "real stdio MCP wire boundary: %s",
    async (scenario) => {
      const root = await mkdtemp(path.join(tmpdir(), "dac-mcp-wire-process-"))
      await Promise.all(["home", "tmp", "config", "data", "cache", "state"].map((name) => mkdir(path.join(root, name))))
      const child = Bun.spawn({
        cmd: [process.execPath, "test", import.meta.path, "--timeout", "20000"],
        cwd: path.resolve(import.meta.dir, "../.."),
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: path.join(root, "home"),
          TMPDIR: path.join(root, "tmp"),
          TMP: path.join(root, "tmp"),
          TEMP: path.join(root, "tmp"),
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          XDG_STATE_HOME: path.join(root, "state"),
          NO_COLOR: "1",
          DEEPAGENT_TEST_MCP_WIRE_CHILD: scenario,
          DEEPAGENT_TEST_MCP_WIRE_RESULT: path.join(root, "result.json"),
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const deadline = setTimeout(() => child.kill(), 30_000)
      try {
        const [status, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        const output = stdout + stderr
        await Bun.write(path.join(root, "child.log"), output)
        const evidence = process.env.DEEPAGENT_TEST_MCP_WIRE_EVIDENCE_DIR
        if (evidence) {
          await mkdir(evidence, { recursive: true })
          await Bun.write(path.join(evidence, `${scenario.replaceAll(" ", "-")}.log`), output)
        }
        expect({ scenario, status, output: status === 0 ? "ok" : output }).toEqual({
          scenario,
          status: 0,
          output: "ok",
        })
        expect(output).toMatch(/\b1 pass\b/)
        expect(output).toMatch(/\b0 fail\b/)
        const assertions = Number(output.match(/(\d+) expect\(\) calls/)?.[1] ?? 0)
        expect(assertions).toBeGreaterThan(0)
        const result = await Bun.file(path.join(root, "result.json")).json()
        expect(result.scenario).toBe(scenario)
        expect(result.pid).toBe(child.pid)
        expect(result.pid).not.toBe(process.pid)
        expect(result.databaseBytes).toBeGreaterThan(0)
        console.info(`[mcp-wire-child] ${scenario}: 1 pass, ${assertions} assertions, pid=${result.pid}`)
      } finally {
        clearTimeout(deadline)
        child.kill()
        await rm(root, { recursive: true, force: true })
      }
    },
    40_000,
  )
}

if (childScenario) {
  if (!scenarios.some((scenario) => scenario === childScenario)) throw new Error("Unknown MCP wire scenario")
  const { Cause, Effect, Exit, Fiber, Layer } = await import("effect")
  const { ToolCallID, ToolFailure } = await import("@deepagent-code/llm")
  const { Database } = await import("@deepagent-code/core/database/database")
  const { EventV2 } = await import("@deepagent-code/core/event")
  const { FSUtil } = await import("@deepagent-code/core/fs-util")
  const { CrossSpawnSpawner } = await import("@deepagent-code/core/cross-spawn-spawner")
  const { Location } = await import("@deepagent-code/core/location")
  const { Project } = await import("@deepagent-code/core/project")
  const { AbsolutePath } = await import("@deepagent-code/core/schema")
  const { AgentV2 } = await import("@deepagent-code/core/agent")
  const { PermissionV2 } = await import("@deepagent-code/core/permission")
  const { PermissionSaved } = await import("@deepagent-code/core/permission/saved")
  const { SessionV2 } = await import("@deepagent-code/core/session")
  const { SessionExecution } = await import("@deepagent-code/core/session/execution")
  const { SessionProjector } = await import("@deepagent-code/core/session/projector")
  const { SessionStore } = await import("@deepagent-code/core/session/store")
  const { SessionMessage } = await import("@deepagent-code/core/session/message")
  const { ApplicationTools } = await import("@deepagent-code/core/tool/application-tools")
  const { Tool } = await import("@deepagent-code/core/tool/tool")
  const { Config } = await import("@/config/config")
  const { MCP } = await import("@/mcp")
  const { McpAuth } = await import("@/mcp/auth")
  const { SecretStore } = await import("@/mcp/secret-store")
  const { V2McpBridge } = await import("@/session/v2-mcp-bridge")
  const { EventV2Bridge } = await import("@/event-v2-bridge")
  const { InstanceRef } = await import("@/effect/instance-ref")
  const { InstanceRegistry } = await import("@/effect/instance-registry")
  const { projectLayer } = await import("../../../core/test/fixture/project-layer")
  const { tmpdirScoped } = await import("../fixture/fixture")
  const { pollWithTimeout, testEffect } = await import("../lib/effect")
  const it = testEffect(CrossSpawnSpawner.defaultLayer)

  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII="

  for (const scenario of scenarios.filter((value) => value === childScenario))
    it.live(
      `real stdio MCP wire boundary: ${scenario}`,
      () =>
        Effect.gen(function* () {
          const directory = yield* tmpdirScoped()
          yield* Effect.promise(() =>
            Bun.write(
              path.join(directory, "control.json"),
              JSON.stringify({
                name: "probe",
                failList: false,
                disconnect: false,
                invalidOutputSchema: scenario === "invalid output schema",
              }),
            ),
          )
          yield* Effect.promise(() => Bun.write(path.join(directory, "body.log"), ""))
          const context = {
            directory,
            worktree: directory,
            project: { id: Project.ID.global, worktree: directory, time: { created: 0, updated: 0 }, sandboxes: [] },
          }
          const location = Layer.succeed(Location.Service, {
            directory: AbsolutePath.make(directory),
            project: { id: Project.ID.global, directory: AbsolutePath.make(directory) },
          })
          const database = Database.layerFromPath(path.join(directory, "authority.sqlite"))
          const events = EventV2.layer.pipe(Layer.provide(database))
          const bridgeEvents = EventV2Bridge.layer.pipe(Layer.provide(events), Layer.provide(database))
          const store = SessionStore.layer.pipe(Layer.provide(database))
          const agents = AgentV2.layer
          const permissions = PermissionV2.layer.pipe(
            Layer.provide(events),
            Layer.provide(location),
            Layer.provide(agents),
            Layer.provide(store),
            Layer.provide(PermissionSaved.layer.pipe(Layer.provide(database))),
            Layer.provide(database),
          )
          // Only configuration storage is a controlled boundary. MCP, its SDK client/transport,
          // permission decisions, session placement and SQL authorities are actual implementations.
          const mcp = MCP.layer.pipe(
            Layer.provide(
              Layer.mock(Config.Service, {
                mcpSnapshot: undefined,
                get: () => Effect.succeed({ mcp: {} }),
                watch: () => Effect.succeed(() => {}),
              }),
            ),
            Layer.provide(McpAuth.defaultLayer),
            Layer.provide(SecretStore.defaultLayer),
            Layer.provide(bridgeEvents),
            Layer.provide(CrossSpawnSpawner.defaultLayer),
            Layer.provide(FSUtil.defaultLayer),
          )
          const sessions = SessionV2.layer.pipe(
            Layer.provide(events),
            Layer.provide(database),
            Layer.provide(store),
            Layer.provide(projectLayer(database)),
            Layer.provide(SessionExecution.noopLayer),
          )
          const layers = Layer.mergeAll(
            database,
            events,
            location,
            store,
            agents,
            permissions,
            mcp,
            sessions,
            ApplicationTools.layer,
            InstanceRegistry.layer,
            SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database)),
            V2McpBridge.layer.pipe(
              Layer.provide(mcp),
              Layer.provide(bridgeEvents),
              Layer.provide(ApplicationTools.layer),
              Layer.provide(InstanceRegistry.layer),
            ),
          )
          yield* Effect.gen(function* () {
            const client = yield* MCP.Service
            const applications = yield* ApplicationTools.Service
            const agent = yield* AgentV2.Service
            yield* agent.update((editor) =>
              editor.update(AgentV2.defaultID, (entry) => {
                entry.permissions = [{ action: "mcp", resource: "*", effect: "allow" }]
              }),
            )
            const session = yield* (yield* SessionV2.Service).create({
              location: { directory: AbsolutePath.make(directory) },
            })
            const settleContext = {
              sessionID: session.id,
              agent: AgentV2.defaultID,
              assistantMessageID: SessionMessage.ID.create(),
              toolCallID: "call_wire",
            }
            const settle = (tool: Parameters<typeof Tool.settle>[0], name: string) =>
              Tool.settle(
                tool,
                {
                  type: "tool-call",
                  id: ToolCallID.make(settleContext.toolCallID),
                  name,
                  input: {},
                },
                settleContext,
              )
            const body = () => Effect.promise(() => Bun.file(path.join(directory, "body.log")).text())
            const current = (name: string) =>
              applications.entries({ directory: AbsolutePath.make(directory) }).get(name)?.tool
            const reject = (tool: Parameters<typeof Tool.settle>[0], name: string) =>
              Effect.gen(function* () {
                const before = yield* body()
                const result = yield* settle(tool, name).pipe(Effect.exit)
                expect(Exit.isFailure(result)).toBe(true)
                if (Exit.isFailure(result)) {
                  const failure = Cause.squash(result.cause)
                  expect(failure).toBeInstanceOf(ToolFailure)
                  if (failure instanceof ToolFailure) expect(failure.metadata?.effectOutcome).toBeUndefined()
                }
                expect(yield* body()).toBe(before)
              })
            yield* InstanceRegistry.initializeInstance(context)
            yield* Effect.addFinalizer(() => InstanceRegistry.disposeInstanceState(context))
            yield* client.add("wire", {
              type: "local",
              command: [process.execPath, path.join(import.meta.dir, "fixture/v2-wire-server.ts"), directory],
              timeout: 3000,
            })
            expect((yield* client.status()).wire?.status).toBe("connected")
            const initial = current("mcp__wire__probe")!
            expect(initial).toBeDefined()
            if (scenario === "invalid output schema") {
              const advertised = (yield* client.tools()).wire_probe!
              const result = yield* Effect.tryPromise({
                try: () =>
                  Promise.resolve(advertised.execute!({}, { toolCallId: "call_invalid_schema", messages: [] })),
                catch: (error) => error,
              }).pipe(Effect.exit)
              expect(Exit.isFailure(result)).toBe(true)
              if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBeInstanceOf(MCP.ToolNotDispatchedError)
              expect(yield* body()).toBe("")
              yield* reject(initial, "mcp__wire__probe")
              expect((yield* client.status()).wire?.status).toBe("connected")
              return
            }
            if (
              ["reconfigure handshake", "disconnect during handshake", "competing replacement handshakes"].includes(
                scenario,
              )
            ) {
              const advertised = (yield* client.tools()).wire_probe!
              const replacement = yield* tmpdirScoped()
              yield* Effect.promise(() => Bun.write(path.join(replacement, "body.log"), ""))
              yield* Effect.promise(() =>
                Bun.write(
                  path.join(replacement, "control.json"),
                  JSON.stringify({ name: "replacement", failList: false, disconnect: false }),
                ),
              )
              const pending = yield* client
                .add("wire", {
                  type: "local",
                  command: [
                    process.execPath,
                    path.join(import.meta.dir, "fixture/v2-wire-server.ts"),
                    replacement,
                    "hold-start",
                  ],
                  timeout: 5000,
                })
                .pipe(Effect.forkChild)
              yield* pollWithTimeout(
                Effect.promise(async () =>
                  (await Bun.file(path.join(replacement, "startup-waiting")).exists()) ? true : undefined,
                ),
                "replacement did not reach held handshake",
              )
              const stale = yield* Effect.tryPromise(() =>
                Promise.resolve(advertised.execute!({}, { toolCallId: "call_during_handshake", messages: [] })),
              ).pipe(Effect.exit)
              expect({ rejected: Exit.isFailure(stale), body: yield* body() }).toEqual({ rejected: true, body: "" })
              yield* reject(initial, "mcp__wire__probe")
              if (scenario === "disconnect during handshake") {
                yield* client.disconnect("wire")
                yield* Effect.promise(() => Bun.write(path.join(replacement, "startup-release"), "release"))
                yield* Fiber.join(pending)
                expect((yield* client.status()).wire?.status).toBe("disabled")
                expect((yield* client.clients()).wire).toBeUndefined()
                expect(Object.keys(yield* client.tools())).toHaveLength(0)
                expect(current("mcp__wire__replacement")).toBeUndefined()
                expect(yield* Effect.promise(() => Bun.file(path.join(replacement, "body.log")).text())).toBe("")
                return
              }
              if (scenario === "competing replacement handshakes") {
                const newer = yield* tmpdirScoped()
                yield* Effect.promise(() => Bun.write(path.join(newer, "body.log"), ""))
                yield* Effect.promise(() =>
                  Bun.write(
                    path.join(newer, "control.json"),
                    JSON.stringify({ name: "newer", failList: false, disconnect: false }),
                  ),
                )
                yield* client.add("wire", {
                  type: "local",
                  command: [process.execPath, path.join(import.meta.dir, "fixture/v2-wire-server.ts"), newer],
                  timeout: 3000,
                })
                const winningClient = (yield* client.clients()).wire
                expect(winningClient).toBeDefined()
                expect(current("mcp__wire__newer")).toBeDefined()
                yield* Effect.promise(() => Bun.write(path.join(replacement, "startup-release"), "release"))
                yield* Fiber.join(pending)
                expect((yield* client.clients()).wire).toBe(winningClient)
                expect((yield* client.status()).wire?.status).toBe("connected")
                expect(Object.keys(yield* client.tools())).toEqual(["wire_newer"])
                expect(current("mcp__wire__replacement")).toBeUndefined()
                expect(current("mcp__wire__newer")).toBeDefined()
                expect(yield* Effect.promise(() => Bun.file(path.join(replacement, "body.log")).text())).toBe("")
                expect(yield* Effect.promise(() => Bun.file(path.join(newer, "body.log")).text())).toBe("")
                return
              }
              yield* Effect.promise(() => Bun.write(path.join(replacement, "startup-release"), "release"))
              yield* Fiber.join(pending)
              expect((yield* client.status()).wire?.status).toBe("connected")
              expect(current("mcp__wire__replacement")).toBeDefined()
              expect(yield* Effect.promise(() => Bun.file(path.join(replacement, "body.log")).text())).toBe("")
              return
            }
            if (scenario === "refresh ordering") {
              const raw = (yield* client.clients()).wire!
              yield* Effect.promise(() =>
                raw.callTool({
                  name: "fixture_control",
                  arguments: { name: "revision_one", failList: false, disconnect: false, hold: "R1" },
                }),
              )
              yield* pollWithTimeout(
                Effect.promise(async () =>
                  (await Bun.file(path.join(directory, "list.log")).text()).includes("revision_one") ? true : undefined,
                ),
                "R1 list did not reach server",
              )
              yield* Effect.promise(() =>
                raw.callTool({
                  name: "fixture_control",
                  arguments: { name: "revision_two", failList: false, disconnect: false, invalidOutputSchema: true },
                }),
              )
              yield* pollWithTimeout(
                Effect.sync(() => current("mcp__wire__revision_two") || undefined),
                "R2 list was not installed",
              )
              yield* Effect.promise(() => raw.callTool({ name: "fixture_release", arguments: { key: "R1" } }))
              yield* Effect.promise(() => raw.ping())
              yield* Effect.yieldNow
              expect(
                (yield* Effect.promise(() => Bun.file(path.join(directory, "replies.log")).text())).trim().split("\n"),
              ).toEqual(["probe", "revision_two", "revision_one"])
              expect(Object.keys(yield* client.tools())).toEqual(["wire_revision_two"])
              expect(current("mcp__wire__revision_one")).toBeUndefined()
              expect(current("mcp__wire__revision_two")).toBeDefined()
              yield* reject(initial, "mcp__wire__probe")
              const currentResult = yield* settle(current("mcp__wire__revision_two")!, "mcp__wire__revision_two").pipe(
                Effect.exit,
              )
              expect(Exit.isFailure(currentResult)).toBe(true)
              if (Exit.isFailure(currentResult)) {
                const error = Cause.squash(currentResult.cause)
                expect(error).toBeInstanceOf(ToolFailure)
                if (error instanceof ToolFailure) expect(error.metadata?.effectOutcome).not.toBe("unknown")
              }
              expect(yield* body()).toBe("")
              return
            }
            if (scenario === "name collision") {
              const collision = yield* tmpdirScoped()
              yield* Effect.promise(() => Bun.write(path.join(collision, "body.log"), ""))
              yield* Effect.promise(() =>
                Bun.write(
                  path.join(collision, "control.json"),
                  JSON.stringify({ name: "probe", failList: false, disconnect: false }),
                ),
              )
              const raw = (yield* client.clients()).wire!
              yield* Effect.promise(() =>
                raw.callTool({
                  name: "fixture_control",
                  arguments: { name: "sub_probe", failList: false, disconnect: false },
                }),
              )
              yield* pollWithTimeout(
                Effect.sync(() => current("mcp__wire__sub_probe") || undefined),
                "first colliding name was not installed",
              )
              const captured = current("mcp__wire__sub_probe")!
              const advertised = (yield* client.tools()).wire_sub_probe!
              yield* client.add("wire_sub", {
                type: "local",
                command: [process.execPath, path.join(import.meta.dir, "fixture/v2-wire-server.ts"), collision],
                timeout: 3000,
              })
              expect((yield* client.status()).wire_sub?.status).toBe("connected")
              expect(Object.keys(yield* client.tools())).toHaveLength(0)
              expect(current("mcp__wire__sub_probe")).toBeUndefined()
              expect(current("mcp__wire_sub__probe")).toBeUndefined()
              yield* reject(captured, "mcp__wire__sub_probe")
              const oldClientTool = yield* Effect.tryPromise(() =>
                Promise.resolve(advertised.execute!({}, { toolCallId: "call_before_collision", messages: [] })),
              ).pipe(Effect.exit)
              expect({ rejected: Exit.isFailure(oldClientTool), body: yield* body() }).toEqual({
                rejected: true,
                body: "",
              })
              expect(yield* Effect.promise(() => Bun.file(path.join(collision, "body.log")).text())).toBe("")
              return
            }
            if (scenario === "task required") {
              const raw = (yield* client.clients()).wire!
              yield* Effect.promise(() =>
                raw.callTool({
                  name: "fixture_control",
                  arguments: { name: "probe", failList: false, disconnect: false, taskRequired: true },
                }),
              )
              yield* pollWithTimeout(
                Effect.sync(() => (current("mcp__wire__probe") === undefined ? true : undefined)),
                "task-required tool remained advertised",
              )
              expect(Object.keys(yield* client.tools())).toHaveLength(0)
              expect(current("mcp__wire__probe")).toBeUndefined()
              yield* reject(initial, "mcp__wire__probe")
              expect(yield* body()).toBe("")
              return
            }
            if (scenario === "structured deduplication") {
              yield* Effect.promise(() =>
                Bun.write(
                  path.join(directory, "control.json"),
                  JSON.stringify({ name: "probe", failList: false, disconnect: false, duplicateStructured: true }),
                ),
              )
              const output = yield* settle(initial, "mcp__wire__probe")
              expect(
                output.content.filter((item) => item.type === "text" && item.text === '{"answer":42}'),
              ).toHaveLength(1)
              expect(output.structured).toMatchObject({ structuredContent: { answer: 42 } })
              expect(yield* body()).toBe("probe\n")
              return
            }
            const output = yield* settle(initial, "mcp__wire__probe")
            expect(output.content).toContainEqual({ type: "text", text: "wire result" })
            expect(output.content).toContainEqual({ type: "text", text: '{"answer":42}' })
            expect(output.content).toContainEqual({
              type: "file",
              source: { type: "data", data: png },
              mime: "image/png",
            })
            expect(JSON.stringify(output.structured)).not.toContain(png)
            expect(output.structured).toMatchObject({ structuredContent: { answer: 42 } })
            expect(yield* body()).toBe("probe\n")

            const permission = yield* PermissionV2.Service
            yield* agent.update((editor) =>
              editor.update(AgentV2.defaultID, (entry) => {
                entry.permissions = [{ action: "mcp", resource: "*", effect: "ask" }]
              }),
            )
            const waiting = yield* settle(initial, "mcp__wire__probe").pipe(Effect.exit, Effect.forkChild)
            const pending = yield* pollWithTimeout(
              permission.list().pipe(Effect.map((requests) => requests[0])),
              "real MCP permission request was not raised",
            )
            expect(pending).toMatchObject({ sessionID: session.id, action: "mcp", resources: ["wire:probe"] })
            yield* client.disconnect("wire")
            yield* permission.reply({ requestID: pending.id, reply: "once" })
            const approvedStale = yield* Fiber.join(waiting)
            expect(Exit.isFailure(approvedStale)).toBe(true)
            if (Exit.isFailure(approvedStale)) expect(Cause.squash(approvedStale.cause)).toBeInstanceOf(ToolFailure)
            expect(yield* body()).toBe("probe\n")
            yield* agent.update((editor) =>
              editor.update(AgentV2.defaultID, (entry) => {
                entry.permissions = [{ action: "mcp", resource: "*", effect: "allow" }]
              }),
            )
            yield* reject(initial, "mcp__wire__probe")
            yield* client.connect("wire")
            expect((yield* client.status()).wire?.status).toBe("connected")
            yield* reject(initial, "mcp__wire__probe")
            const reconnected = current("mcp__wire__probe")!
            const raw = (yield* client.clients()).wire!
            yield* Effect.promise(() =>
              raw.callTool({
                name: "fixture_control",
                arguments: { name: "next", failList: false, disconnect: false },
              }),
            )
            yield* pollWithTimeout(
              Effect.sync(() => current("mcp__wire__next") || undefined),
              "bridge did not refresh after wire notification",
            )
            yield* reject(reconnected, "mcp__wire__probe")
            const refreshed = current("mcp__wire__next")!

            yield* Effect.promise(() =>
              raw.callTool({ name: "fixture_control", arguments: { name: "next", failList: true, disconnect: false } }),
            )
            yield* pollWithTimeout(
              Effect.promise(async () =>
                (await Bun.file(path.join(directory, "list.log")).text()).includes("failed") ? true : undefined,
              ),
              "failed list request did not reach server",
            )
            yield* reject(refreshed, "mcp__wire__next")
            expect(Object.keys(yield* client.tools())).toHaveLength(0)

            yield* Effect.promise(() =>
              Bun.write(
                path.join(directory, "control.json"),
                JSON.stringify({ name: "lost", failList: false, disconnect: true }),
              ),
            )
            yield* client.connect("wire")
            const lost = current("mcp__wire__lost")!
            expect(lost).toBeDefined()
            const unknown = yield* settle(lost, "mcp__wire__lost").pipe(Effect.exit)
            expect(Exit.isFailure(unknown)).toBe(true)
            if (Exit.isFailure(unknown))
              expect(Cause.squash(unknown.cause)).toMatchObject({
                _tag: "LLM.ToolFailure",
                metadata: { effectOutcome: "unknown" },
              })
            expect(yield* body()).toBe("probe\nlost\n")
            yield* pollWithTimeout(
              client.status().pipe(Effect.map((statuses) => (statuses.wire?.status === "failed" ? true : undefined))),
              "transport close did not revoke client",
            )
            yield* reject(lost, "mcp__wire__lost")
          }).pipe(Effect.provide(layers), Effect.provideService(InstanceRef, context))
          yield* Effect.promise(() =>
            Bun.write(
              process.env.DEEPAGENT_TEST_MCP_WIRE_RESULT!,
              JSON.stringify({
                scenario,
                pid: process.pid,
                databaseBytes: Bun.file(path.join(directory, "authority.sqlite")).size,
              }),
            ),
          )
        }),
      20_000,
    )
}
