import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { QueryLogTool } from "@/tool/query_log"
import { Truncate } from "@/tool/truncate"
import { BackgroundJob } from "@/background/job"
import { Database } from "@deepagent-code/core/database/database"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(
  Agent.defaultLayer,
  BackgroundJob.defaultLayer,
  Config.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Session.defaultLayer,
  SessionProjector.defaultLayer,
  EventV2Bridge.defaultLayer,
  Truncate.defaultLayer,
  Database.defaultLayer,
  RuntimeFlags.layer(),
))

describe("query_log V2 compatibility archive", () => {
  it.instance("reconciles a projected user message before reading the archive", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "query-log-v2" })
      const messageID = MessageID.ascending()
      const marker = `projected-${crypto.randomUUID()}`
      yield* sessions.updateMessage({
        id: messageID,
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID,
        sessionID: session.id,
        type: "text",
        text: marker,
      })
      const tool = yield* QueryLogTool
      const definition = yield* tool.init()
      const result = yield* definition.execute({ keyword: marker, limit: 10 }, {
        sessionID: session.id,
        messageID: MessageID.ascending(),
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      })
      expect(result.output).toContain(marker)
      expect(result.metadata.count).toBe(1)
    }),
  )
})
