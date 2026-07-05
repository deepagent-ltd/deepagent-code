// End-to-end smoke test for the IM @agent path through the REAL server stack.
//
// This is the test that would have caught the production defect where IM agent
// mentions were wired to core SessionV2 (a no-op execution layer) and never
// actually ran an agent. It boots the real `HttpApiApp.routes` — including the
// IM runtime layer (ServerAgentExecutorLive/ServerAgentListProviderLive) — and a
// fake LLM server, posts an `@build` message to an IM group over HTTP, and asserts
// that a real agent reply is persisted back into the group.
//
// The agent runs in a forked fiber (fire-and-forget from the message handler), so
// we poll the group for the assistant reply rather than awaiting the response.

import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Flag } from "@deepagent-code/core/flag/flag"
import { Workspace } from "../../src/control-plane/workspace"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Session } from "@/session/session"
import { Database } from "@deepagent-code/core/database/database"
import * as Log from "@deepagent-code/core/util/log"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { pollWithTimeout, testEffect } from "../lib/effect"

void Log.init({ print: false })

const originalWorkspaces = Flag.DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES
const workspaceLayer = Workspace.defaultLayer.pipe(
  Layer.provide(InstanceStore.defaultLayer),
  Layer.provide(InstanceBootstrap.defaultLayer),
)
const instanceStoreLayer = InstanceStore.defaultLayer.pipe(
  Layer.provide(
    Layer.succeed(InstanceBootstrapService.Service, InstanceBootstrapService.Service.of({ run: Effect.void })),
  ),
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(
  Layer.mergeAll(
    instanceStoreLayer,
    Project.defaultLayer,
    Session.defaultLayer,
    workspaceLayer,
    Database.defaultLayer,
    httpApiLayer,
  ),
)

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  if (response.status !== 200)
    return response.text.pipe(Effect.flatMap((text) => Effect.die(new Error(`HTTP ${response.status}: ${text}`))))
  return response.json.pipe(Effect.map((value) => value as T))
}

function requestJson<T>(path: string, init?: RequestInit) {
  return request(path, init).pipe(Effect.flatMap(json<T>))
}

afterEach(async () => {
  Flag.DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
})

type IMGroup = { id: string }
type IMMessage = { id: string; senderType: string; senderID: string; content: string }
type IMMessagePage = { messages: IMMessage[] }

describe("IM agent HttpApi (real SessionPrompt stack)", () => {
  it.live(
    "an @agent mention runs the real agent and persists its reply into the group",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* llm.text("hello from the agent", { usage: { input: 1, output: 1 } })

        const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
        const q = `directory=${encodeURIComponent(directory)}`
        const headers = { "content-type": "application/json" }

        // Create an IM group in this workspace.
        const group = yield* requestJson<IMGroup>(`/api/v1/im/groups?${q}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ type: "project", name: "Smoke" }),
        })

        // Post a user message that @mentions the built-in "build" agent.
        const createResponse = yield* request(`/api/v1/im/groups/${group.id}/messages?${q}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ senderType: "user", type: "text", content: "@build please answer" }),
        })
        expect(createResponse.status).toBe(200)

        // The agent runs in a forked fiber; poll the group until its reply lands.
        const agentReply = yield* pollWithTimeout(
          requestJson<IMMessagePage>(`/api/v1/im/groups/${group.id}/messages?${q}`, { headers }).pipe(
            Effect.map((page) => page.messages.find((m) => m.senderType === "agent")),
          ),
          "agent reply was never persisted to the IM group",
          "15 seconds",
        )

        expect(agentReply).toBeDefined()
        expect(agentReply!.content.length).toBeGreaterThan(0)
        expect(agentReply!.content).toContain("hello from the agent")
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
  )
})
