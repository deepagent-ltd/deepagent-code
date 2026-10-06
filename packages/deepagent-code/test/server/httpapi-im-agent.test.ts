// E2E for the V2 IM durable-only @mention path through the REAL server stack.
//
// The legacy path (ServerAgentExecutor → fresh V1 session per turn → SessionPrompt.promptOrSteer,
// forked fire-and-forget from the message handler) is deleted. This test pins its durable
// replacement end-to-end: the handler performs exactly ONE durable SessionV2 admission per mention
// (the session_input row keyed by the deterministic prompt id), the production V2 runner executes
// the turn against a fake LLM, the settle drives the im_reply_outbox, and the terminal assistant
// reply is durably delivered back into the IM group (metadata.sessionID binds the reply to the
// admitted session — only the outbox writes that linkage).
//
// No live-provider key is needed: the V2 runner talks to the in-process TestLLMServer.

import { afterEach, beforeEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { like } from "drizzle-orm"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Flag } from "@deepagent-code/core/flag/flag"
import { Workspace } from "../../src/control-plane/workspace"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Session } from "@/session/session"
import { IMReplyOutbox } from "@/im/im-reply-outbox"
import { SessionInputTable } from "@deepagent-code/core/session/sql"
import { IMMentionIntentTable } from "@deepagent-code/core/im/mention-intent.sql"
import { Database } from "@deepagent-code/core/database/database"
import * as Log from "@deepagent-code/core/util/log"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { pollWithTimeout, testEffect } from "../lib/effect"

void Log.init({ print: false })

const originalWorkspaces = Flag.DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES
const originalResponder = process.env.DEEPAGENT_IM_AGENT_RESPONDER
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

beforeEach(() => {
  process.env.DEEPAGENT_IM_AGENT_RESPONDER = "on"
})

afterEach(async () => {
  Flag.DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  if (originalResponder === undefined) delete process.env.DEEPAGENT_IM_AGENT_RESPONDER
  if (originalResponder !== undefined) process.env.DEEPAGENT_IM_AGENT_RESPONDER = originalResponder
  await disposeAllInstances()
  await resetDatabase()
})

type IMGroup = { id: string }
type IMMessage = {
  id: string
  senderType: string
  senderID: string
  content: string
  metadata: { type?: string; sessionID?: string } | null
}
type IMMessagePage = { messages: IMMessage[] }

/** All durable IM-lane admissions (the `ses_im_` session identity lane). */
const imAdmissions = () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select({ id: SessionInputTable.id, sessionID: SessionInputTable.session_id })
      .from(SessionInputTable)
      .where(like(SessionInputTable.session_id, "ses_im_%"))
      .all()
      .pipe(Effect.orDie)
  })

const postMention = (directory: string, groupID: string, content: string, clientRequestID?: string) =>
  request(`/api/v1/im/groups/${groupID}/messages?directory=${encodeURIComponent(directory)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ senderType: "user", type: "text", content, clientRequestID }),
  })

describe("IM agent HttpApi (V2 durable-only)", () => {
  it.live(
    "default and explicit OFF chat stays non-executable after enabling and exact HTTP retry",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
        const group = yield* requestJson<IMGroup>(
          `/api/v1/im/groups?directory=${encodeURIComponent(directory)}`,
          { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "project", name: "Chat only" }) },
        )
        delete process.env.DEEPAGENT_IM_AGENT_RESPONDER
        expect((yield* postMention(directory, group.id, "@auto default chat", "default-chat")).status).toBe(200)
        process.env.DEEPAGENT_IM_AGENT_RESPONDER = "off"
        expect((yield* postMention(directory, group.id, "@auto disabled chat", "disabled-chat")).status).toBe(200)
        const { db } = yield* Database.Service
        expect(yield* db.select().from(IMMentionIntentTable).all().pipe(Effect.orDie)).toEqual([])
        expect(yield* imAdmissions()).toEqual([])

        process.env.DEEPAGENT_IM_AGENT_RESPONDER = "on"
        expect((yield* postMention(directory, group.id, "@auto default chat", "default-chat")).status).toBe(200)
        expect((yield* postMention(directory, group.id, "@auto disabled chat", "disabled-chat")).status).toBe(200)
        // Cover a real background reconcile interval, not only the handler's immediate path.
        yield* Effect.sleep(`${IMReplyOutbox.IM_REPLY_RECONCILE_INTERVAL_MS + 250} millis`)
        expect(yield* db.select().from(IMMentionIntentTable).all().pipe(Effect.orDie)).toEqual([])
        expect(yield* imAdmissions()).toEqual([])
        expect(yield* llm.calls).toBe(0)
        const page = yield* requestJson<IMMessagePage>(
          `/api/v1/im/groups/${group.id}/messages?directory=${encodeURIComponent(directory)}`,
        )
        expect(page.messages).toHaveLength(2)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
    30_000,
  )

  for (const setting of [undefined, "off"]) {
    it.live(
      `the background daemon preserves old pending mentions without admission when responder is ${setting ?? "unset"}`,
      () =>
        Effect.gen(function* () {
          if (setting === undefined) delete process.env.DEEPAGENT_IM_AGENT_RESPONDER
          if (setting !== undefined) process.env.DEEPAGENT_IM_AGENT_RESPONDER = setting
          const llm = yield* TestLLMServer
          const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
          const group = yield* requestJson<IMGroup>(
            `/api/v1/im/groups?directory=${encodeURIComponent(directory)}`,
            { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "project", name: "Pending safety" }) },
          )
          const message = yield* postMention(directory, group.id, "@auto previously authorized live intent").pipe(
            Effect.flatMap(json<IMMessage>),
          )
          const { db } = yield* Database.Service
          // This is an already-durable intent from an earlier ON process, not a history scan.
          yield* db.insert(IMMentionIntentTable).values({
            id: `imi_pending_${message.id}`,
            message_id: message.id,
            agent_name: "auto",
            directory,
            workspace_id: directory,
            user_id: "server",
            origin: "local",
            status: "pending",
            created_at: 1,
            updated_at: 1,
          }).run().pipe(Effect.orDie)
          const before = yield* db.select().from(IMMentionIntentTable).all().pipe(Effect.orDie)
          yield* Effect.sleep(`${IMReplyOutbox.IM_REPLY_RECONCILE_INTERVAL_MS + 250} millis`)
          expect(yield* db.select().from(IMMentionIntentTable).all().pipe(Effect.orDie)).toEqual(before)
          expect(yield* imAdmissions()).toEqual([])
          expect(yield* llm.calls).toBe(0)
        }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
      30_000,
    )
  }

  it.live(
    "an @mention performs exactly one durable V2 admission and the outbox delivers the terminal reply",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* llm.text("hello from the v2 agent", { usage: { input: 1, output: 1 } })

        const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
        const group = yield* requestJson<IMGroup>(
          `/api/v1/im/groups?directory=${encodeURIComponent(directory)}`,
          { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "project", name: "V2 Smoke" }) },
        )

        // The send itself synchronously performs the single durable admission.
        expect((yield* postMention(directory, group.id, "@auto please answer")).status).toBe(200)
        const admissions = yield* imAdmissions()
        expect(admissions.length).toBe(1)

        // The agent runs through SessionExecution's advisory wake; the reply returns via the
        // im_reply_outbox daemon (the ONLY writer of metadata.sessionID on agent messages).
        const reply = yield* pollWithTimeout(
          requestJson<IMMessagePage>(
            `/api/v1/im/groups/${group.id}/messages?directory=${encodeURIComponent(directory)}`,
          ).pipe(Effect.map((page) => page.messages.find((m) => m.senderType === "agent" && m.metadata?.sessionID))),
          "the outbox never delivered the agent reply to the group",
          "60 seconds",
        )
        expect(reply.content).toContain("hello from the v2 agent")
        expect(reply.metadata?.type).toBe("agent_run")
        expect(reply.metadata?.sessionID).toBe(admissions[0]!.sessionID)

        // No duplicate admission materialized while the turn ran.
        expect((yield* imAdmissions()).length).toBe(1)

        // The outbox row settles delivered.
        const { db } = yield* Database.Service
        const outbox = yield* db
          .select({ status: IMReplyOutbox.IMReplyOutboxTable.status, text: IMReplyOutbox.IMReplyOutboxTable.reply_text })
          .from(IMReplyOutbox.IMReplyOutboxTable)
          .all()
          .pipe(Effect.orDie)
        expect(outbox).toEqual([{ status: "delivered", text: "hello from the v2 agent" }])
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
    120_000,
  )

  it.live(
    "a follow-up mention adopts the same (group, agent) session — one stable lane, two admissions",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* llm.text("first v2 reply", { usage: { input: 1, output: 1 } })
        yield* llm.text("second v2 reply", { usage: { input: 1, output: 1 } })

        const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
        const group = yield* requestJson<IMGroup>(
          `/api/v1/im/groups?directory=${encodeURIComponent(directory)}`,
          { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "project", name: "V2 Adopt" }) },
        )

        yield* postMention(directory, group.id, "@auto first question")
        const firstReply = yield* pollWithTimeout(
          requestJson<IMMessagePage>(
            `/api/v1/im/groups/${group.id}/messages?directory=${encodeURIComponent(directory)}`,
          ).pipe(Effect.map((page) => page.messages.find((m) => m.senderType === "agent" && m.content.includes("first v2 reply")))),
          "first reply was never delivered",
          "60 seconds",
        )
        const firstAdmissions = yield* imAdmissions()

        yield* postMention(directory, group.id, "@auto follow-up question")
        yield* pollWithTimeout(
          requestJson<IMMessagePage>(
            `/api/v1/im/groups/${group.id}/messages?directory=${encodeURIComponent(directory)}`,
          ).pipe(Effect.map((page) => page.messages.find((m) => m.senderType === "agent" && m.content.includes("second v2 reply")))),
          "second reply was never delivered",
          "60 seconds",
        )

        const admissions = yield* imAdmissions()
        expect(admissions.length).toBe(2)
        // Adoption: both mentions steered the SAME durable (group, agent) session.
        expect(new Set(admissions.map((row) => row.sessionID)).size).toBe(1)
        expect(firstReply.metadata?.sessionID).toBe(admissions[0]!.sessionID)
        expect(firstAdmissions[0]!.sessionID).toBe(admissions[1]!.sessionID)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
    120_000,
  )
})
