import { afterEach, describe, expect } from "bun:test"
import { mkdirSync, readdirSync, rmSync } from "node:fs"
import { ConfigV1 } from "@deepagent-code/core/v1/config/config"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Deferred, Effect, Layer } from "effect"
import type * as Scope from "effect/Scope"
import { HttpServer } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { createOpencodeClient } from "@deepagent-code/sdk"
import { validateSession } from "../../src/cli/tui/validate-session"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { Global } from "@deepagent-code/core/global"

import type { Config } from "@/config/config"
import { Session as SessionNs } from "@/session/session"
import { errorMessage } from "../../src/util/error"
import { TestLLMServer } from "../lib/llm-server"
import path from "path"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { Database } from "@deepagent-code/core/database/database"
import { httpApiLayer, httpApiLayerWithConfig } from "./httpapi-layer"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const testServices = (server: typeof httpApiLayer) =>
  Layer.mergeAll(
    FSUtil.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap)),
    Database.defaultLayer,
    server,
  )

const it = testEffect(testServices(httpApiLayer))
const authIt = testEffect(
  testServices(
    httpApiLayerWithConfig({
      DEEPAGENT_CODE_SERVER_PASSWORD: "secret",
      DEEPAGENT_CODE_SERVER_USERNAME: "deepagent-code",
    }),
  ),
)

type ServerPath = "default" | "raw"
type Sdk = ReturnType<typeof createOpencodeClient>
// The generated SDK now types `response`/`request` as optional (an error can originate from building
// the request itself, before any response exists). These helpers only run against completed requests,
// so response is present in practice — match the optional contract and assert it at the read site.
type SdkResult = { response?: Response; data?: unknown; error?: unknown }
type Captured = { status: number; data?: unknown; error?: unknown }
type ProjectFixture = { sdk: Sdk; directory: string }
type LlmProjectFixture = ProjectFixture & { llm: TestLLMServer["Service"] }
type TestServices =
  | FSUtil.Service
  | ChildProcessSpawner.ChildProcessSpawner
  | InstanceStore.Service
  | HttpServer.HttpServer
type TestScope = Scope.Scope | TestServices

function client(
  serverPath: ServerPath,
  directory?: string,
  input?: {
    headers?: Record<string, string>
    workspaceID?: string
    onRequest?: (request: Request) => void
  },
) {
  return serverFetch(serverPath, input).pipe(
    Effect.map((fetch) =>
      createOpencodeClient({
        baseUrl: "http://localhost",
        directory,
        workspace: input?.workspaceID,
        headers: input?.headers,
        fetch,
      }),
    ),
  )
}

function serverFetch(serverPath: ServerPath, input?: { onRequest?: (request: Request) => void }) {
  return HttpServer.HttpServer.use((server) =>
    Effect.sync(() => {
      void serverPath
      const baseUrl = HttpServer.formatAddress(server.address)
      return Object.assign(
        async (request: RequestInfo | URL, init?: RequestInit) => {
          const source = request instanceof Request ? request : new Request(request, init)
          input?.onRequest?.(source)
          const url = new URL(source.url)
          return globalThis.fetch(new Request(new URL(`${url.pathname}${url.search}`, baseUrl), source))
        },
        { preconnect: globalThis.fetch.preconnect },
      ) satisfies typeof globalThis.fetch
    }),
  )
}

function authorization(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

function call<T>(request: () => Promise<T>) {
  return Effect.promise(request)
}

function capture(request: () => Promise<SdkResult>) {
  return call(request).pipe(
    Effect.map((result) => ({
      status: result.response?.status ?? 0,
      data: result.data,
      error: result.error,
    })),
  )
}

function captureThrown(request: () => Promise<unknown>) {
  return call(async () => {
    try {
      await request()
    } catch (error) {
      return error
    }
  })
}

function expectStatus(request: () => Promise<{ response?: Response }>, status: number) {
  return call(request).pipe(
    Effect.tap((result) => Effect.sync(() => expect(result.response?.status).toBe(status))),
    Effect.asVoid,
  )
}

function firstEvent(open: (signal: AbortSignal) => Promise<{ stream: AsyncIterator<unknown> }>) {
  return Effect.acquireRelease(
    Effect.sync(() => new AbortController()),
    (controller) => Effect.sync(() => controller.abort()),
  ).pipe(
    Effect.flatMap((controller) =>
      Effect.acquireRelease(
        call(() => open(controller.signal)),
        (events) => call(async () => void (await events.stream.return?.(undefined))).pipe(Effect.ignore),
      ).pipe(
        Effect.flatMap((events) =>
          call(() => events.stream.next()).pipe(
            Effect.timeoutOrElse({
              duration: "1 second",
              orElse: () => Effect.fail(new Error("timed out waiting for SDK event")),
            }),
          ),
        ),
        Effect.map((result) => result.value),
      ),
    ),
  )
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}
}

function array(value: unknown) {
  return Array.isArray(value) ? value : []
}

function statuses(input: Record<string, Captured>) {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, value.status]))
}

function firstPartText(value: unknown) {
  return record(array(record(value).parts)[0]).text
}

function sessionTitles(value: unknown) {
  return array(value)
    .map((item) => record(item).title)
    .filter((title): title is string => typeof title === "string")
    .sort()
}

function resetState() {
  return Effect.promise(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })
}

function httpapi<A, E>(name: string, effect: Effect.Effect<A, E, TestScope>) {
  it.live(name, effect)
}

function httpapiInstance<A, E>(
  name: string,
  options: {
    serverPath: ServerPath
    git?: boolean
    config?: Partial<ConfigV1.Info>
    setup?: (dir: string) => Effect.Effect<void, E, TestServices>
  },
  run: (input: ProjectFixture) => Effect.Effect<A, E, TestScope>,
) {
  it.instance(
    name,
    Effect.gen(function* () {
      const instance = yield* TestInstance
      yield* options.setup?.(instance.directory) ?? Effect.void
      return yield* run({ sdk: yield* client(options.serverPath, instance.directory), directory: instance.directory })
    }),
    { git: options.git ?? true, config: { formatter: false, lsp: false, ...options.config } },
  )
}

function serverPathParity<A, E>(
  name: string,
  scenario: (serverPath: ServerPath) => Effect.Effect<A, E, TestScope>,
  timeout?: number,
) {
  it.live(name, scenario("raw"), timeout)
}

function withProject<A, E, E2 = never>(
  serverPath: ServerPath,
  options: {
    git?: boolean
    config?: Partial<ConfigV1.Info>
    setup?: (dir: string) => Effect.Effect<void, E2, TestServices>
  },
  run: (input: ProjectFixture) => Effect.Effect<A, E, TestScope>,
) {
  return Effect.gen(function* () {
    const directory = yield* tmpdirScoped({
      git: options.git ?? false,
      config: { formatter: false, lsp: false, ...options.config },
    })
    yield* options.setup?.(directory) ?? Effect.void
    return yield* run({ sdk: yield* client(serverPath, directory), directory })
  })
}

function withStandardProject<A, E>(
  serverPath: ServerPath,
  run: (input: ProjectFixture) => Effect.Effect<A, E, TestScope>,
) {
  return withProject(serverPath, { setup: writeStandardFiles }, run)
}

function withFakeLlm<A, E>(serverPath: ServerPath, run: (input: LlmProjectFixture) => Effect.Effect<A, E, TestScope>) {
  return Effect.gen(function* () {
    const llm = yield* TestLLMServer
    return yield* withProject(serverPath, { config: testProviderConfig(llm.url) }, (input) => run({ ...input, llm }))
  }).pipe(Effect.provide(TestLLMServer.layer))
}

function withFakeLlmProject<A, E>(
  serverPath: ServerPath,
  options: { setup?: (dir: string) => Effect.Effect<void, E, TestServices> },
  run: (input: LlmProjectFixture) => Effect.Effect<A, E, TestScope>,
) {
  return Effect.gen(function* () {
    const llm = yield* TestLLMServer
    return yield* withProject(
      serverPath,
      {
        config: testProviderConfig(llm.url),
        setup: options.setup,
      },
      (input) => run({ ...input, llm }),
    )
  }).pipe(Effect.provide(TestLLMServer.layer))
}

function writeStandardFiles(dir: string) {
  return FSUtil.Service.use((fs) =>
    Effect.all([
      fs.writeWithDirs(path.join(dir, "hello.txt"), "hello"),
      fs.writeWithDirs(path.join(dir, "needle.ts"), "export const needle = 'sdk-parity'\n"),
    ]).pipe(Effect.asVoid),
  )
}

function writeProjectSkill(dir: string) {
  return FSUtil.Service.use((fs) =>
    fs.writeWithDirs(
      path.join(dir, ".deepagent-code", "skills", "project-rest-skill", "SKILL.md"),
      `---
name: project-rest-skill
description: A project skill visible to REST API prompts.
---

# Project REST Skill
`,
    ),
  )
}

function writeReviewRun(runsDir: string, id = "run_review_route") {
  const runDir = path.join(runsDir, id)
  mkdirSync(runDir, { recursive: true })
  const store = new AgentGateway.DeepAgentDocumentStore.DocumentStore(path.join(runDir, "graph"))
  AgentGateway.DeepAgentRunGraph.buildRunGraph(store, {
    runId: id,
    taskId: "task_review_route",
    agentMode: "max",
    status: "completed",
    round: 1,
    nextActionPolicy: "continue_or_complete",
    runContextMarkdown: "# route review context",
    candidate: { summary: "candidate from route graph", status: "validated" },
    decision: { verdict: "accept", reason: "validated" },
    learningCandidates: [
      {
        candidate_id: "strategy_candidate:route:first-fast-design",
        type: "strategy",
        status: "staged",
        source_run_id: id,
        source_round: 1,
        summary: "route-level learning candidate",
        evidence_refs: ["RUN_CONTEXT.md"],
        confidence: 0.9,
      },
    ],
  })
  return runDir
}

function seedMessage(directory: string, sessionID: string) {
  const id = SessionID.make(sessionID)
  return InstanceStore.Service.use((store) =>
    store.provide(
      { directory },
      SessionNs.Service.use((svc) =>
        Effect.gen(function* () {
          const message = yield* svc.updateMessage({
            id: MessageID.ascending(),
            sessionID: id,
            role: "user",
            time: { created: Date.now() },
            agent: "test",
            model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
            tools: {},
          } satisfies SessionV1.User)
          const part = yield* svc.updatePart({
            id: PartID.ascending(),
            sessionID: id,
            messageID: message.id,
            type: "text",
            text: "seeded message",
          })
          return { message, part }
        }),
      ).pipe(Effect.provide(SessionNs.defaultLayer)),
    ),
  )
}

// The runtime is unconditionally V2-only (RuntimeFlags.coreV2Only), so every prompt route qualifies
// the Core V2 execution owner before admission. The dev V2-owner chain (mint keypair + verifier
// env) is armed process-wide by test/preload.ts — Reference defaults cache on first access, so
// arming must precede every test file; see test/lib/v2-owner.ts for why the keypair is a
// process-wide singleton. Each test builds its routes layer inside the test body, after the mint
// has already armed.
afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("HttpApi SDK", () => {
  httpapi(
    "uses the generated SDK for global and control routes",
    Effect.gen(function* () {
      const sdk = yield* client("raw")
      const health = yield* call(() => sdk.global.health())
      const log = yield* call(() => sdk.app.log({ service: "httpapi-sdk-test", level: "info", message: "hello" }))

      expect(health.response?.status).toBe(200)
      expect(health.data).toMatchObject({ healthy: true })
      expect(health.data?.runtimeId).toBeString()
      expect(yield* firstEvent((signal) => sdk.global.event({ signal }))).toMatchObject({
        payload: { type: "server.connected" },
      })
      expect(log.response?.status).toBe(200)
      expect(log.data).toBe(true)
      yield* expectStatus(() => sdk.auth.set({ providerID: "test" }), 400)
    }),
  )

  httpapiInstance(
    "uses the generated SDK for safe instance routes",
    { serverPath: "raw", git: false, setup: writeStandardFiles },
    ({ sdk }) =>
      Effect.gen(function* () {
        const file = yield* call(() => sdk.file.read({ path: "hello.txt" }))
        const session = yield* call(() => sdk.session.create({ title: "sdk" }))
        const listed = yield* call(() => sdk.session.list({ roots: true, limit: 10 }))

        expect(file.response?.status).toBe(200)
        expect(file.data).toMatchObject({ content: "hello" })
        expect(session.response?.status).toBe(200)
        expect(session.data).toMatchObject({ title: "sdk" })
        expect(listed.response?.status).toBe(200)
        expect(listed.data?.map((item) => item.id)).toContain(session.data?.id)

        yield* Effect.all([
          expectStatus(() => sdk.project.current(), 200),
          expectStatus(() => sdk.config.get(), 200),
          expectStatus(() => sdk.config.providers(), 200),
          expectStatus(() => sdk.find.files({ query: "hello", limit: 10 }), 200),
        ])
      }),
  )

  httpapiInstance(
    "uses the generated SDK for DeepAgent review routes",
    { serverPath: "raw", git: false, setup: writeStandardFiles },
    ({ sdk }) =>
      Effect.gen(function* () {
        const reviews = yield* call(() => sdk.deepagent.reviews())
        expect(reviews.response?.status).toBe(200)
        expect(reviews.data).toMatchObject({ reviews: expect.any(Array) })

        const candidate = {
          candidate_id: "strategy_candidate:sdk:test",
          type: "strategy" as const,
          status: "staged" as const,
          source_run_id: "run_sdk",
          source_round: 1,
          summary: "sdk generated route candidate",
          evidence_refs: ["graph/run_context"],
          confidence: 0.9,
        }
        const promoted = yield* call(() =>
          sdk.deepagent.knowledge.promote({
            candidate,
            origin: "run_local",
            verdict: { pass: true, reason: "sdk test", evidence: candidate.evidence_refs },
            approval: { approver: "sdk-test", approved: true, note: "generated client route" },
          }),
        )
        expect(promoted.response?.status).toBe(400)
        expect(promoted.error).toMatchObject({ message: expect.stringContaining("durable candidate") })

        const rejectedCandidate = { ...candidate, candidate_id: "strategy_candidate:sdk:reject" }
        const rejected = yield* call(() =>
          sdk.deepagent.knowledge.reject({
            candidate: rejectedCandidate,
            reason: "sdk reject test",
          }),
        )
        expect(rejected.response?.status).toBe(400)
        expect(rejected.error).toMatchObject({ message: expect.stringContaining("durable candidate") })
      }),
  )

  httpapiInstance(
    "lists DeepAgent reviews from configured runsDir with workspace routing",
    { serverPath: "raw", git: false, setup: writeStandardFiles },
    ({ sdk, directory }) =>
      Effect.gen(function* () {
        // The route reads runsDir from the AgentGateway.Runtime captured when this test's routes
        // layer was built (immutable V2 gateway storage root) — per-request env redirection no
        // longer reaches it. The captured root is the canonical Global.Path.agent.runs under the
        // preload's DEEPAGENT_CODE_TEST_HOME, so write the fixture there. Clear stale entries first:
        // the runs dir is shared per test process and the assertion pins the exact list.
        const runsDir = Global.Path.agent.runs
        for (const entry of readdirSync(runsDir)) {
          rmSync(path.join(runsDir, entry), { recursive: true, force: true })
        }
        mkdirSync(runsDir, { recursive: true })
        try {
          writeReviewRun(runsDir)

          const reviews = yield* call(() => sdk.deepagent.reviews({ directory }))

          expect(reviews.response?.status).toBe(200)
          expect(reviews.data).toMatchObject({
            reviews: [
              expect.objectContaining({
                runId: "run_review_route",
                agentMode: "max",
                status: "completed",
                learningCandidates: [
                  expect.objectContaining({ candidateId: "strategy_candidate:route:first-fast-design" }),
                ],
              }),
            ],
          })
        } finally {
          rmSync(path.join(runsDir, "run_review_route"), { recursive: true, force: true })
        }
      }),
  )

  httpapi(
    "routes configured SDK directory and workspace for v2 location GETs",
    withProject("raw", { setup: writeStandardFiles }, ({ directory }) =>
      Effect.gen(function* () {
        const workspaceID = "wrk_sdk"
        let request: Request | undefined
        const sdk = yield* client("raw", directory, {
          workspaceID,
          onRequest: (value) => (request = value),
        })
        const file = yield* call(() => sdk.v2.fs.read({ path: "hello.txt" }))
        const url = new URL(request!.url)

        expect(file.response?.status).toBe(200)
        expect(file.data).toMatchObject({ data: { content: "hello" } })
        expect(url.searchParams.get("directory")).toBe(directory)
        expect(url.searchParams.get("workspace")).toBe(workspaceID)
        expect(url.searchParams.get("location[directory]")).toBe(directory)
        expect(url.searchParams.get("location[workspace]")).toBe(workspaceID)
        expect(request!.headers.has("x-deepagent-code-directory")).toBe(false)
        expect(request!.headers.has("x-deepagent-code-workspace")).toBe(false)
      }),
    ),
  )

  serverPathParity("matches generated SDK global and control behavior", (serverPath) =>
    Effect.gen(function* () {
      const sdk = yield* client(serverPath)
      const health = yield* capture(() => sdk.global.health())
      const log = yield* capture(() => sdk.app.log({ service: "sdk-parity", level: "info", message: "hello" }))
      const invalidAuth = yield* capture(() => sdk.auth.set({ providerID: "test" }))

      return {
        statuses: statuses({ health, log, invalidAuth }),
        health: record(health.data).healthy,
        log: log.data,
      }
    }),
  )

  serverPathParity("matches generated SDK global event stream", (serverPath) =>
    Effect.gen(function* () {
      const sdk = yield* client(serverPath)
      const event = yield* firstEvent((signal) => sdk.global.event({ signal }))
      return { type: record(record(event).payload).type }
    }),
  )

  serverPathParity("matches generated SDK instance event stream", (serverPath) =>
    withStandardProject(serverPath, ({ sdk }) =>
      firstEvent((signal) => sdk.event.subscribe(undefined, { signal })).pipe(
        Effect.map((event) => ({ type: record(record(event).payload).type })),
      ),
    ),
  )

  serverPathParity("matches generated SDK missing session errors", (serverPath) =>
    withStandardProject(serverPath, ({ sdk }) =>
      Effect.gen(function* () {
        const sessionID = "ses_missing"
        const expected = {
          name: "NotFoundError",
          data: { message: `Session not found: ${sessionID}` },
        }
        const missing = yield* capture(() => sdk.session.get({ sessionID }))
        const thrown = yield* captureThrown(() => sdk.session.get({ sessionID }, { throwOnError: true }))

        // Result-tuple path: error body is preserved as-is so existing
        // consumers reading `result.error.name` / `JSON.stringify(error)`
        // keep working byte-for-byte.
        expect(missing.error).toEqual(expected)
        // throwOnError path: SDK wraps the body in a real Error with the
        // server's message, with the original parsed body preserved under
        // `.cause.body`.
        expect(thrown).toBeInstanceOf(Error)
        expect((thrown as Error).message).toBe(expected.data.message)
        expect(((thrown as Error).cause as { body: unknown }).body).toEqual(expected)
        return {
          status: missing.status,
          error: missing.error,
          thrown,
        }
      }),
    ),
  )

  serverPathParity("formats missing session validation errors for -s", (serverPath) =>
    withStandardProject(serverPath, ({ directory }) =>
      Effect.gen(function* () {
        const sessionID = "ses_206f84f18ffeZ6hhD7pFYAiW5T"
        const fetch = yield* serverFetch(serverPath)
        const thrown = yield* captureThrown(() =>
          validateSession({
            url: "http://localhost",
            directory,
            sessionID,
            fetch,
          }),
        )
        expect(errorMessage(thrown)).toBe(`Session not found: ${sessionID}`)
        return errorMessage(thrown)
      }),
    ),
  )

  authIt.instance(
    "uses generated SDK basic auth behavior",
    Effect.gen(function* () {
      const instance = yield* TestInstance
      yield* writeStandardFiles(instance.directory)
      const missingSdk = yield* client("raw", instance.directory)
      const missing = yield* capture(() => missingSdk.file.read({ path: "hello.txt" }))
      const badSdk = yield* client("raw", instance.directory, {
        headers: { authorization: authorization("deepagent-code", "wrong") },
      })
      const bad = yield* capture(() => badSdk.file.read({ path: "hello.txt" }))
      const goodSdk = yield* client("raw", instance.directory, {
        headers: { authorization: authorization("deepagent-code", "secret") },
      })
      const good = yield* capture(() => goodSdk.file.read({ path: "hello.txt" }))

      expect(statuses({ missing, bad, good })).toEqual({ missing: 401, bad: 401, good: 200 })
      expect(record(good.data).content).toBe("hello")
    }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  serverPathParity("matches generated SDK instance read routes", (serverPath) =>
    withProject(serverPath, { git: true, setup: writeStandardFiles }, ({ sdk, directory }) =>
      Effect.gen(function* () {
        const project = yield* capture(() => sdk.project.current())
        const projects = yield* capture(() => sdk.project.list())
        const paths = yield* capture(() => sdk.path.get())
        const config = yield* capture(() => sdk.config.get())
        const providers = yield* capture(() => sdk.config.providers())
        const file = yield* capture(() => sdk.file.read({ path: "hello.txt" }))
        const files = yield* capture(() => sdk.file.list({ path: "." }))
        const fileStatus = yield* capture(() => sdk.file.status())
        const findFiles = yield* capture(() => sdk.find.files({ query: "hello", limit: 10 }))
        const findText = yield* capture(() => sdk.find.text({ pattern: "sdk-parity" }))
        const agents = yield* capture(() => sdk.app.agents())
        const skills = yield* capture(() => sdk.app.skills())
        const tools = yield* capture(() => sdk.tool.ids())
        const vcs = yield* capture(() => sdk.vcs.get())
        const formatter = yield* capture(() => sdk.formatter.status())
        const lsp = yield* capture(() => sdk.lsp.status())

        return {
          statuses: statuses({
            project,
            projects,
            paths,
            config,
            providers,
            file,
            files,
            fileStatus,
            findFiles,
            findText,
            agents,
            skills,
            tools,
            vcs,
            formatter,
            lsp,
          }),
          project: { worktreeSelected: record(project.data).worktree === directory },
          paths: { directorySelected: record(paths.data).directory === directory },
          file: record(file.data).content,
          hasProject: array(projects.data).length > 0,
          foundFile: JSON.stringify(findFiles.data).includes("hello.txt"),
          foundText: JSON.stringify(findText.data ?? null).includes("sdk-parity"),
          listedFile: JSON.stringify(files.data).includes("hello.txt"),
          vcs: { hasBranch: typeof record(vcs.data).branch === "string" },
        }
      }),
    ),
  )

  serverPathParity("matches generated SDK session lifecycle routes", (serverPath) =>
    withStandardProject(serverPath, ({ sdk }) =>
      Effect.gen(function* () {
        const parent = yield* capture(() => sdk.session.create({ title: "parent" }))
        const parentID = String(record(parent.data).id)
        const child = yield* capture(() => sdk.session.create({ title: "child", parentID }))
        const childID = String(record(child.data).id)
        const get = yield* capture(() => sdk.session.get({ sessionID: parentID }))
        const update = yield* capture(() => sdk.session.update({ sessionID: parentID, title: "renamed" }))
        const roots = yield* capture(() => sdk.session.list({ roots: true, limit: 10 }))
        const all = yield* capture(() => sdk.session.list({ roots: false, limit: 10 }))
        const children = yield* capture(() => sdk.session.children({ sessionID: parentID }))
        const todo = yield* capture(() => sdk.session.todo({ sessionID: parentID }))
        const continuationResolutions = yield* capture(() =>
          sdk.session.continuationResolutionList({ sessionID: parentID }),
        )
        const rejectedContinuationResolution = yield* capture(() =>
          sdk.session.continuationResolutionResolve({
            sessionID: parentID,
            runID: "run_missing",
            failureID: "failure_missing",
            commandID: "command_missing",
            decision: "abandoned",
            reason: "sdk route parity",
            riskAcknowledged: false,
          }),
        )
        expect(continuationResolutions.status).toBe(200)
        expect(array(continuationResolutions.data)).toEqual([])
        // V2-only contract: the legacy continuation-resolution mutation is fail-closed under the
        // Core V2-only profile (refuseLegacyRecoveryMutation) — the exact durable maintenance
        // recovery command surface owns this authority now. Assert the typed refusal, not a 409
        // from the retired legacy state machine.
        expect(rejectedContinuationResolution.status).toBe(503)
        expect(rejectedContinuationResolution.error).toMatchObject({
          _tag: "ServiceUnavailableError",
          service: "session.continuation-resolution",
          message: expect.stringContaining("legacy recovery state machine"),
        })
        const status = yield* capture(() => sdk.session.status())
        const messages = yield* capture(() => sdk.session.messages({ sessionID: parentID }))
        const missingGet = yield* capture(() => sdk.session.get({ sessionID: "ses_missing" }))
        const missingMessages = yield* capture(() => sdk.session.messages({ sessionID: "ses_missing", limit: 2 }))
        const invalidCursor = yield* capture(() =>
          sdk.session.messages({ sessionID: parentID, limit: 2, before: "bad" }),
        )
        const deleted = yield* capture(() => sdk.session.delete({ sessionID: childID }))
        const getDeleted = yield* capture(() => sdk.session.get({ sessionID: childID }))

        return {
          statuses: statuses({
            parent,
            child,
            get,
            update,
            roots,
            all,
            children,
            todo,
            continuationResolutions,
            rejectedContinuationResolution,
            status,
            messages,
            missingGet,
            missingMessages,
            invalidCursor,
            deleted,
            getDeleted,
          }),
          getTitle: record(get.data).title,
          updatedTitle: record(update.data).title,
          rootTitles: sessionTitles(roots.data),
          allTitles: sessionTitles(all.data),
          childCount: array(children.data).length,
          todoCount: array(todo.data).length,
          continuationResolutionCount: array(continuationResolutions.data).length,
          messageCount: array(messages.data).length,
        }
      }),
    ),
  )

  serverPathParity("matches generated SDK session message and part routes", (serverPath) =>
    withStandardProject(serverPath, ({ sdk, directory }) =>
      Effect.gen(function* () {
        const session = yield* capture(() => sdk.session.create({ title: "messages" }))
        const sessionID = String(record(session.data).id)
        const seeded = yield* seedMessage(directory, sessionID)
        const list = yield* capture(() => sdk.session.messages({ sessionID }))
        const page = yield* capture(() => sdk.session.messages({ sessionID, limit: 1 }))
        const message = yield* capture(() => sdk.session.message({ sessionID, messageID: seeded.message.id }))
        const partUpdate = yield* capture(() =>
          sdk.part.update({
            sessionID,
            messageID: seeded.message.id,
            partID: seeded.part.id,
            part: { ...seeded.part, text: "updated message" } as NonNullable<
              Parameters<Sdk["part"]["update"]>[0]["part"]
            >,
          }),
        )
        const updated = yield* capture(() => sdk.session.message({ sessionID, messageID: seeded.message.id }))
        const partDelete = yield* capture(() =>
          sdk.part.delete({ sessionID, messageID: seeded.message.id, partID: seeded.part.id }),
        )
        const withoutPart = yield* capture(() => sdk.session.message({ sessionID, messageID: seeded.message.id }))
        const deleteMessage = yield* capture(() =>
          sdk.session.deleteMessage({ sessionID, messageID: seeded.message.id }),
        )
        const missingMessage = yield* capture(() => sdk.session.message({ sessionID, messageID: seeded.message.id }))

        return {
          statuses: statuses({
            session,
            list,
            page,
            message,
            partUpdate,
            updated,
            partDelete,
            withoutPart,
            deleteMessage,
            missingMessage,
          }),
          listCount: array(list.data).length,
          pageCount: array(page.data).length,
          initialText: firstPartText(message.data),
          updatedText: firstPartText(updated.data),
          partCountAfterDelete: array(record(withoutPart.data).parts).length,
        }
      }),
    ),
  )

  // The V2 session update is an authoritative EventV2 write. Its projected event must
  // reach the same ProjectBus and /event stream the SDK subscribes to. Legacy part
  // writes are read-only and must fail without changing the projected message.
  serverPathParity("streams V2 session updates to /event subscribers", (serverPath) =>
    withStandardProject(serverPath, ({ sdk, directory }) =>
      Effect.gen(function* () {
        const session = yield* capture(() => sdk.session.create({ title: "V2 session event" }))
        const sessionID = String(record(session.data).id)
        const seeded = yield* seedMessage(directory, sessionID)

        const controller = new AbortController()
        yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))
        const events = yield* call(() => sdk.event.subscribe(undefined, { signal: controller.signal }))
        yield* Effect.addFinalizer(() =>
          call(async () => void (await events.stream.return?.(undefined))).pipe(Effect.ignore),
        )

        const ready = yield* Deferred.make<void>()
        const received = yield* Deferred.make<unknown>()

        yield* call(async () => {
          for await (const event of events.stream) {
            const payload = record(event).payload ?? event
            const type = record(payload).type
            if (type === "server.connected") {
              Deferred.doneUnsafe(ready, Effect.void)
              continue
            }
            if (type === "session.updated") {
              Deferred.doneUnsafe(received, Effect.succeed(payload))
              return
            }
          }
        }).pipe(Effect.forkScoped)

        yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for /event server.connected", "2 seconds")

        const updated = yield* capture(() =>
          sdk.part.update({
            sessionID,
            messageID: seeded.message.id,
            partID: seeded.part.id,
            part: { ...seeded.part, text: "updated via sync" } as NonNullable<
              Parameters<Sdk["part"]["update"]>[0]["part"]
            >,
          }),
        )
        expect(updated.status).toBe(503)
        expect(updated.error).toMatchObject({
          _tag: "ServiceUnavailableError",
          service: "session.updatePart",
        })
        const message = yield* capture(() => sdk.session.message({ sessionID, messageID: seeded.message.id }))
        expect(firstPartText(message.data)).toBe(seeded.part.text)

        const renamed = yield* capture(() => sdk.session.update({ sessionID, title: "updated via V2" }))
        expect(renamed.status).toBe(200)

        const event = yield* awaitWithTimeout(
          Deferred.await(received),
          "timed out waiting for session.updated bus payload over /event",
          "5 seconds",
        )
        const properties = record(record(event).properties)
        expect(record(properties.info)).toMatchObject({ id: sessionID, title: "updated via V2" })
        return { type: record(event).type, title: record(properties.info).title }
      }),
    ),
  )

  serverPathParity("matches generated SDK prompt no-reply routes", (serverPath) =>
    withFakeLlmProject(serverPath, {}, ({ sdk, llm }) =>
      Effect.gen(function* () {
        // Safety net only: the no-reply contract is that NOTHING reaches the model (asserted below).
        yield* llm.text("no-reply must not dispatch")
        const session = yield* capture(() => sdk.session.create({ title: "prompt" }))
        const sessionID = String(record(session.data).id)
        const prompt = yield* capture(() =>
          sdk.session.prompt({
            sessionID,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "hello" }],
          }),
        )
        const asyncSession = yield* capture(() => sdk.session.create({ title: "async prompt" }))
        const asyncSessionID = String(record(asyncSession.data).id)
        const asyncPrompt = yield* capture(() =>
          sdk.session.promptAsync({
            sessionID: asyncSessionID,
            intentID: "intent_http_async_admission",
            intentSource: "composer",
            intentVariant: "original",
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            noReply: true,
            parts: [{ type: "text", text: "async hello" }],
          }),
        )

        // V2-only contract, sync leg (RI-124 adjudicated: mirror-after-admission): the sync
        // noReply prompt admits durably and mirrors the user row straight from the admission
        // receipt, so the route returns the created user message immediately — no provider
        // dispatch, and the next drain's promotion publish is a no-op against the mirrored row.
        expect(prompt.status).toBe(200)
        const syncMessage = record(prompt.data)
        expect(record(syncMessage.info)).toMatchObject({ role: "user" })
        const syncTexts = array(syncMessage.parts)
          .map((part) => record(part).text)
          .filter((text): text is string => typeof text === "string")
        expect(syncTexts).toContain("hello")
        const syncList = yield* capture(() => sdk.session.messages({ sessionID }))
        expect(JSON.stringify(syncList.data)).toContain("hello")

        // V2-only contract, async leg: admission is acknowledged with the V2 delivery vocabulary
        // ("steer"; the retired legacy intent claim reported "turn"), then the forked drain promotes
        // and mirrors the user message WITHOUT a provider dispatch — transcript visibility is
        // eventual, not synchronous.
        expect(asyncPrompt.status).toBe(200)
        expect(asyncPrompt.data).toMatchObject({ delivery: "steer" })
        expect(typeof record(asyncPrompt.data).messageID).toBe("string")
        const asyncTexts = yield* pollWithTimeout(
          capture(() => sdk.session.messages({ sessionID: asyncSessionID })).pipe(
            Effect.map((response) => {
              const texts = array(response.data)
                .flatMap((item) => array(record(item).parts))
                .map((part) => record(part).text)
                .filter((text): text is string => typeof text === "string")
              return texts.includes("async hello") ? texts : undefined
            }),
          ),
          "no-reply async prompt was never promoted into the transcript",
          "15 seconds",
        )
        expect(yield* llm.calls).toBe(0)

        return {
          statuses: statuses({ session, prompt, asyncSession, asyncPrompt }),
          asyncTexts,
        }
      }),
    ),
  )

  serverPathParity(
    "acknowledges async prompts after admission without waiting for model completion",
    (serverPath) =>
      withFakeLlm(serverPath, ({ sdk, llm }) => {
        const responseGate = Promise.withResolvers<void>()
        return Effect.gen(function* () {
          yield* llm.hold("delayed response", responseGate.promise)
          const session = yield* capture(() =>
            sdk.session.create({
              title: "async admission",
              permission: [{ permission: "*", pattern: "*", action: "allow" }],
            }),
          )
          const sessionID = String(record(session.data).id)

          const prompt = yield* capture(() =>
            sdk.session.promptAsync({
              sessionID,
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              parts: [{ type: "text", text: "persist before acknowledging" }],
            }),
          ).pipe(Effect.timeout("2 seconds"))
          // V2 admission contract: the acknowledgement crosses the durable admission boundary, but
          // transcript visibility is eventual — the forked drain promotes the input and the egress
          // mirrors it. It must land while the held model response is still pending.
          const messages = yield* pollWithTimeout(
            capture(() => sdk.session.messages({ sessionID })).pipe(
              Effect.map((response) =>
                JSON.stringify(response.data).includes("persist before acknowledging")
                  ? response.data
                  : undefined,
              ),
            ),
            "async prompt was not promoted into the transcript before the model responded",
            "5 seconds",
          )
          yield* llm.wait(1).pipe(Effect.timeout("2 seconds"))

          expect(prompt.status).toBe(200)
          // V2 admission vocabulary: prompts admit on the "steer" channel by default.
          expect(prompt.data).toMatchObject({ delivery: "steer" })
          expect(JSON.stringify(messages)).toContain("persist before acknowledging")
          responseGate.resolve()
          yield* pollWithTimeout(
            capture(() => sdk.session.status()).pipe(
              Effect.map((response) => (sessionID in record(response.data) ? undefined : true)),
            ),
            "async prompt runner did not become idle after the delayed response completed",
            "15 seconds",
          )
        }).pipe(Effect.ensuring(Effect.sync(() => responseGate.resolve())))
      }),
    60_000,
  )

  serverPathParity("matches generated SDK prompt streaming through fake LLM", (serverPath) =>
    withFakeLlm(serverPath, ({ sdk, llm }) =>
      Effect.gen(function* () {
        yield* llm.text("fake world", { usage: { input: 11, output: 7 } })
        const session = yield* capture(() =>
          sdk.session.create({
            title: "llm prompt",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        )
        const sessionID = String(record(session.data).id)
        const prompt = yield* capture(() =>
          sdk.session.prompt({
            sessionID,
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "hello llm" }],
          }),
        )
        const messages = yield* capture(() => sdk.session.messages({ sessionID }))
        const inputs = yield* llm.inputs

        return {
          statuses: statuses({ session, prompt, messages }),
          calls: inputs.length,
          requestedModel: inputs[0]?.model,
          responseText: JSON.stringify(prompt.data).includes("fake world"),
          persistedText: JSON.stringify(messages.data).includes("fake world"),
          userText: JSON.stringify(messages.data).includes("hello llm"),
        }
      }),
    ),
  )

  httpapi(
    "includes project skills in REST API prompt context",
    withFakeLlmProject("default", { setup: writeProjectSkill }, ({ sdk, llm }) =>
      Effect.gen(function* () {
        yield* llm.text("skill context ok", { usage: { input: 11, output: 7 } })
        const session = yield* capture(() =>
          sdk.session.create({
            title: "project skill prompt",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        )
        const sessionID = String(record(session.data).id)
        const prompt = yield* capture(() =>
          sdk.session.prompt({
            sessionID,
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "hello skill context" }],
          }),
        )
        const inputs = yield* llm.inputs

        expect(session.status).toBe(200)
        expect(prompt.status).toBe(200)
        // Locate the request that carries the user prompt rather than assuming inputs[0]: under
        // load an auxiliary request (title/summary/etc.) can reach the fake LLM first, and the
        // skill-context guarantee belongs to the prompt request specifically.
        const promptInput = inputs.find((input) => JSON.stringify(input).includes("hello skill context"))
        expect(promptInput).toBeDefined()
        expect(JSON.stringify(promptInput)).toContain("project-rest-skill")
      }),
    ),
  )

  serverPathParity("matches generated SDK TUI validation and command routes", (serverPath) =>
    withStandardProject(serverPath, ({ sdk }) =>
      Effect.gen(function* () {
        const session = yield* capture(() => sdk.session.create({ title: "tui" }))
        const sessionID = String(record(session.data).id)
        const appendPrompt = yield* capture(() => sdk.tui.appendPrompt({ text: "hello" }))
        const openHelp = yield* capture(() => sdk.tui.openHelp())
        const openSessions = yield* capture(() => sdk.tui.openSessions())
        const openThemes = yield* capture(() => sdk.tui.openThemes())
        const openModels = yield* capture(() => sdk.tui.openModels())
        const submitPrompt = yield* capture(() => sdk.tui.submitPrompt())
        const clearPrompt = yield* capture(() => sdk.tui.clearPrompt())
        const executeCommand = yield* capture(() => sdk.tui.executeCommand({ command: "session_new" }))
        const showToast = yield* capture(() => sdk.tui.showToast({ title: "SDK", message: "hello", variant: "info" }))
        const selectSession = yield* capture(() => sdk.tui.selectSession({ sessionID }))
        const missingSession = yield* capture(() => sdk.tui.selectSession({ sessionID: "ses_missing" }))
        const invalidSession = yield* capture(() => sdk.tui.selectSession({ sessionID: "invalid_session_id" }))

        return {
          statuses: statuses({
            session,
            appendPrompt,
            openHelp,
            openSessions,
            openThemes,
            openModels,
            submitPrompt,
            clearPrompt,
            executeCommand,
            showToast,
            selectSession,
            missingSession,
            invalidSession,
          }),
          data: {
            appendPrompt: appendPrompt.data,
            openHelp: openHelp.data,
            openSessions: openSessions.data,
            openThemes: openThemes.data,
            openModels: openModels.data,
            submitPrompt: submitPrompt.data,
            clearPrompt: clearPrompt.data,
            executeCommand: executeCommand.data,
            showToast: showToast.data,
            selectSession: selectSession.data,
          },
        }
      }),
    ),
  )

  serverPathParity("matches generated SDK project git initialization", (serverPath) =>
    withProject(serverPath, {}, ({ sdk, directory }) =>
      Effect.gen(function* () {
        const before = yield* capture(() => sdk.project.current())
        const init = yield* capture(() => sdk.project.initGit())
        const after = yield* capture(() => sdk.project.current())

        return {
          statuses: statuses({ before, init, after }),
          before: {
            vcs: record(before.data).vcs ?? null,
            worktree: record(before.data).worktree,
          },
          init: {
            vcs: record(init.data).vcs,
            worktreeSelected: record(init.data).worktree === directory,
          },
          after: {
            vcs: record(after.data).vcs,
            worktreeSelected: record(after.data).worktree === directory,
          },
        }
      }),
    ),
  )
})
