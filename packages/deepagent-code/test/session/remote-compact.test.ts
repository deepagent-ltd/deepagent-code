import { describe, expect } from "bun:test"
import { RequestExecutor } from "@deepagent-code/llm/route"
import { Effect, Layer, Ref } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import type { ModelMessage } from "ai"
import { join } from "path"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import remoteCompactPersistenceMigration from "@deepagent-code/core/database/migration/20260820000000_remote_compact_persistence"
import type { Provider } from "@/provider/provider"
import { RemoteCompact } from "@/session/remote-compact"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

const JSON_HEADERS = { "content-type": "application/json" } as const

const openaiModel: Provider.Model = {
  id: ModelV2.ID.make("gpt-5-mini"),
  providerID: ProviderV2.ID.make("openai"),
  api: {
    id: "gpt-5-mini",
    url: "https://api.openai.test/v1",
    npm: "@ai-sdk/openai",
  },
  name: "GPT-5 Mini",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, input: 128_000, output: 32_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

const deepseekModel: Provider.Model = {
  ...openaiModel,
  id: ModelV2.ID.make("deepseek-chat"),
  providerID: ProviderV2.ID.make("deepseek"),
  api: { id: "deepseek-chat", url: "https://api.deepseek.com/v1", npm: "@ai-sdk/openai-compatible" },
  name: "DeepSeek Chat",
}

const anthropicModel: Provider.Model = {
  ...openaiModel,
  id: ModelV2.ID.make("claude-sonnet-4"),
  providerID: ProviderV2.ID.make("anthropic"),
  api: { id: "claude-sonnet-4", url: "https://api.anthropic.com", npm: "@ai-sdk/anthropic" },
  name: "Claude Sonnet 4",
}

const providerInfo: Provider.Info = {
  id: ProviderV2.ID.make("openai"),
  name: "OpenAI",
  source: "config",
  env: ["OPENAI_API_KEY"],
  options: { apiKey: "test-openai-key" },
  models: {},
}

const history: ModelMessage[] = [
  { role: "user", content: [{ type: "text", text: "Fix the failing test." }] },
  { role: "assistant", content: [{ type: "text", text: "Looking into it." }] },
]

const input = (model: Provider.Model, sessionID = "ses_remote_compact"): RemoteCompact.RemoteCompactionInput => ({
  sessionID,
  model,
  provider: providerInfo,
  auth: undefined,
  messages: history,
})

type Handler = (handlerInput: {
  readonly request: HttpClientRequest.HttpClientRequest
  readonly text: string
  readonly respond: (body: ConstructorParameters<typeof Response>[0], init?: ResponseInit) => HttpClientResponse.HttpClientResponse
}) => Effect.Effect<HttpClientResponse.HttpClientResponse>

const handlerLayer = (handler: Handler): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
        const text = yield* Effect.promise(() => web.text())
        return yield* handler({
          request,
          text,
          respond: (body, init) => HttpClientResponse.fromWeb(request, new Response(body, init)),
        })
      }),
    ),
  )

const compactLayer = (handler: Handler): Layer.Layer<RequestExecutor.Service> =>
  Layer.provideMerge(RequestExecutor.layer, handlerLayer(handler))

// Fail-over must be immediate: never burn a status-retry budget on compact.
const noRetries = Effect.provideService(RequestExecutor.CurrentRetryLimit, 0)

const compactResponse = (encryptedContent: string) =>
  JSON.stringify({ output: [{ type: "compaction", id: "cmp_1", encrypted_content: encryptedContent }] })

// Every test provides its own executor layer: layers are memoized by identity
// during build, so a shared describe-level layer would leak its HttpClient
// binding into tests that expect a different handler.
const noHttpLayer = compactLayer(() => Effect.die(new Error("no HTTP expected")))

describe("remote compaction capability branch", () => {
  // `live` keeps the real clock so retry backoff (should it ever fire) never
  // stalls on TestClock.
  const it = testEffect(Layer.empty)

  it.live("routes canonical OpenAI to the server-side path", () =>
    Effect.gen(function* () {
      expect(RemoteCompact.supportsRemoteCompaction(openaiModel)).toBe(true)
      const outcome = yield* RemoteCompact.attemptRemoteCompaction(input(openaiModel)).pipe(
        Effect.provide(
          compactLayer(({ respond }) => Effect.succeed(respond(compactResponse("enc-openai"), { headers: JSON_HEADERS }))),
        ),
        noRetries,
      )
      expect(outcome).toEqual({ used: "remote", encryptedContent: "enc-openai" })
      expect(RemoteCompact.EncryptedContentStore.get("ses_remote_compact")).toBe("enc-openai")
    }),
  )

  it.live("routes deepseek (verified /responses/compact support) to the server-side path", () =>
    Effect.gen(function* () {
      expect(RemoteCompact.supportsRemoteCompaction(deepseekModel)).toBe(true)
      const outcome = yield* RemoteCompact.attemptRemoteCompaction(input(deepseekModel, "ses_deepseek")).pipe(
        Effect.provide(
          compactLayer(({ respond }) => Effect.succeed(respond(compactResponse("enc-deepseek"), { headers: JSON_HEADERS }))),
        ),
        noRetries,
      )
      expect(outcome).toEqual({ used: "remote", encryptedContent: "enc-deepseek" })
      expect(RemoteCompact.EncryptedContentStore.get("ses_deepseek")).toBe("enc-deepseek")
    }),
  )

  it.live("routes anthropic to the local path without HTTP", () =>
    Effect.gen(function* () {
      expect(RemoteCompact.supportsRemoteCompaction(anthropicModel)).toBe(false)
      const outcome = yield* RemoteCompact.attemptRemoteCompaction(input(anthropicModel, "ses_anthropic")).pipe(
        Effect.provide(noHttpLayer),
        noRetries,
      )
      expect(outcome.used).toBe("local")
    }),
  )

  it.live("falls back to local when no API key is configured", () =>
    Effect.gen(function* () {
      const outcome = yield* RemoteCompact.attemptRemoteCompaction({
        ...input(openaiModel, "ses_no_key"),
        provider: { ...providerInfo, options: {} },
      }).pipe(
        Effect.provide(noHttpLayer),
        noRetries,
      )
      expect(outcome.used).toBe("local")
      expect(outcome.used === "local" && outcome.reason).toContain("API key")
    }),
  )
})

describe("remote compaction fail-over", () => {
  const it = testEffect(Layer.empty)

  it.live("fails over to local on provider HTTP errors", () =>
    RemoteCompact.attemptRemoteCompaction(input(openaiModel, "ses_http_fail")).pipe(
      Effect.provide(
        compactLayer(({ respond }) =>
          Effect.succeed(respond(JSON.stringify({ error: "boom" }), { status: 500, headers: JSON_HEADERS })),
        ),
      ),
      noRetries,
      Effect.tap((outcome) =>
        Effect.sync(() => {
          expect(outcome.used).toBe("local")
          expect(RemoteCompact.EncryptedContentStore.get("ses_http_fail")).toBeUndefined()
        }),
      ),
    ),
  )

  it.live("fails over to local when the compact payload is malformed", () =>
    RemoteCompact.attemptRemoteCompaction(input(openaiModel, "ses_bad_payload")).pipe(
      Effect.provide(compactLayer(({ respond }) => Effect.succeed(respond("not-json", { headers: JSON_HEADERS })))),
      noRetries,
      Effect.tap((outcome) =>
        Effect.sync(() => {
          expect(outcome.used).toBe("local")
        }),
      ),
    ),
  )

  it.live("fails over to local when no compaction item is returned", () =>
    RemoteCompact.attemptRemoteCompaction(input(openaiModel, "ses_no_item")).pipe(
      Effect.provide(
        compactLayer(({ respond }) => Effect.succeed(respond(JSON.stringify({ output: [] }), { headers: JSON_HEADERS }))),
      ),
      noRetries,
      Effect.tap((outcome) =>
        Effect.sync(() => {
          expect(outcome.used).toBe("local")
        }),
      ),
    ),
  )

  // §4.3 same-provenance guard: a blob minted by another provider can never be
  // replayed — drop it and fall back to local summarization, without HTTP.
  it.live("clears a foreign-provider blob and fails over to local (§4.3 same source)", () =>
    Effect.gen(function* () {
      RemoteCompact.EncryptedContentStore.set("ses_cross_provider", "enc-foreign", { providerID: "deepseek" })
      const outcome = yield* RemoteCompact.attemptRemoteCompaction(input(openaiModel, "ses_cross_provider")).pipe(
        Effect.provide(noHttpLayer),
        noRetries,
      )
      expect(outcome.used).toBe("local")
      expect(outcome.used === "local" && outcome.reason).toContain("belongs to provider deepseek")
      expect(RemoteCompact.EncryptedContentStore.get("ses_cross_provider")).toBeUndefined()
    }),
  )

  // §4.3 capability loss: switching to a model whose route does not serve
  // /responses/compact invalidates any staged blob so it can never be replayed.
  it.live("clears a stale blob when the capability probe is false (§4.3)", () =>
    Effect.gen(function* () {
      RemoteCompact.EncryptedContentStore.set("ses_capability_lost", "enc-stale")
      const outcome = yield* RemoteCompact.attemptRemoteCompaction(input(anthropicModel, "ses_capability_lost")).pipe(
        Effect.provide(noHttpLayer),
        noRetries,
      )
      expect(outcome.used).toBe("local")
      expect(RemoteCompact.EncryptedContentStore.get("ses_capability_lost")).toBeUndefined()
    }),
  )
})

describe("remote compaction encrypted_content staging", () => {
  const it = testEffect(Layer.empty)

  it.live("sends the staged encrypted context back on the next compaction", () =>
    Effect.gen(function* () {
      const sessionID = "ses_round_trip"
      const bodies = yield* Ref.make<ReadonlyArray<Record<string, unknown>>>([])
      const counter = yield* Ref.make(0)
      const layer: Layer.Layer<RequestExecutor.Service> = compactLayer(({ request, respond }) =>
        Effect.gen(function* () {
          const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
          expect(web.url).toBe("https://api.openai.test/v1/responses/compact")
          const body = (yield* Effect.promise(() => web.json())) as Record<string, unknown>
          yield* Ref.update(bodies, (items) => [...items, body])
          const current = yield* Ref.get(counter)
          yield* Ref.set(counter, current + 1)
          return respond(compactResponse(`enc-${current + 1}`), { headers: JSON_HEADERS })
        }),
      )
      const first = yield* RemoteCompact.attemptRemoteCompaction(input(openaiModel, sessionID)).pipe(
        Effect.provide(layer),
        noRetries,
      )
      expect(first).toEqual({ used: "remote", encryptedContent: "enc-1" })
      expect(RemoteCompact.EncryptedContentStore.get(sessionID)).toBe("enc-1")
      const second = yield* RemoteCompact.attemptRemoteCompaction(input(openaiModel, sessionID)).pipe(
        Effect.provide(layer),
        noRetries,
      )
      expect(second).toEqual({ used: "remote", encryptedContent: "enc-2" })
      const sent = yield* Ref.get(bodies)
      expect(sent).toHaveLength(2)
      const firstInput = sent[0]!.input as ReadonlyArray<Record<string, unknown>>
      const secondInput = sent[1]!.input as ReadonlyArray<Record<string, unknown>>
      expect(firstInput[0]).toEqual({ role: "user", content: [{ type: "input_text", text: "Fix the failing test." }] })
      expect(secondInput[0]).toEqual({ type: "compaction", encrypted_content: "enc-1" })
      expect(sent[1]!.model).toBe("gpt-5-mini")
      expect(sent[0]!.stream).toBeUndefined()
    }),
  )

  it.live("clearing the store drops the staged context (restart semantics)", () =>
    Effect.gen(function* () {
      RemoteCompact.EncryptedContentStore.set("ses_restart", "enc-lost")
      expect(RemoteCompact.EncryptedContentStore.get("ses_restart")).toBe("enc-lost")
      RemoteCompact.EncryptedContentStore.clear("ses_restart")
      expect(RemoteCompact.EncryptedContentStore.get("ses_restart")).toBeUndefined()
    }),
  )
})

// Gap 1 durability: with a bound Database handle the blob survives a process
// restart (fresh Database instance over the same file). The migration is not
// registered in migration.gen.ts yet (mainline does that), so each phase
// applies it explicitly via applyOnly — tracked, hence idempotent across the
// two phases.
describe("remote compaction encrypted_content durability (Gap 1)", () => {
  const it = testEffect(Layer.empty)

  const seedSession = (db: Database.Interface["db"], sessionID: string) =>
    Effect.gen(function* () {
      yield* db.run(`
        INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
        VALUES ('project-${sessionID}', '/repo', '[]', 1, 1)
      `)
      yield* db.run(`
        INSERT INTO session (
          id, project_id, slug, directory, title, version, mutation_epoch, time_created, time_updated
        ) VALUES (
          '${sessionID}', 'project-${sessionID}', '${sessionID}', '/repo', 'Remote compact', '1', 0, 1, 1
        )
      `)
    })

  it.instance(
    "set → restart (new Database instance, same file) → get hits with attribution",
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = join(test.directory, "remote-compact.db")
      const sessionID = "ses_persist_round_trip"
      yield* Effect.addFinalizer(() => Effect.sync(() => RemoteCompact.EncryptedContentStore.bind(undefined)))

      // Phase 1 — first process: bind, seed, store.
      yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.applyOnly(db, [remoteCompactPersistenceMigration])
        yield* seedSession(db, sessionID)
        RemoteCompact.EncryptedContentStore.bind(db)
        RemoteCompact.EncryptedContentStore.set(sessionID, "enc-durable", {
          providerID: "openai",
          modelID: "gpt-5-mini",
          sourceRunID: "run-persist-1",
        })
        expect(RemoteCompact.EncryptedContentStore.get(sessionID)).toBe("enc-durable")
        RemoteCompact.EncryptedContentStore.bind(undefined)
        // Unbound store is memory-only: the durable row is invisible here.
        expect(RemoteCompact.EncryptedContentStore.get(sessionID)).toBeUndefined()
      }).pipe(Effect.provide(Database.layerFromPath(file)))

      // Phase 2 — restart: a fresh Database instance over the same file sees it.
      yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.applyOnly(db, [remoteCompactPersistenceMigration])
        RemoteCompact.EncryptedContentStore.bind(db)
        expect(RemoteCompact.EncryptedContentStore.get(sessionID)).toBe("enc-durable")
        const record = RemoteCompact.EncryptedContentStore.getRecord(sessionID)
        expect(record?.providerID).toBe("openai")
        expect(record?.modelID).toBe("gpt-5-mini")
        expect(record?.sourceRunID).toBe("run-persist-1")

        // Latest wins: a second set replaces the row (never a second row).
        RemoteCompact.EncryptedContentStore.set(sessionID, "enc-durable-2", { providerID: "openai" })
        expect(RemoteCompact.EncryptedContentStore.get(sessionID)).toBe("enc-durable-2")

        // Fail-over clear removes the durable row as well.
        RemoteCompact.EncryptedContentStore.clear(sessionID)
        expect(RemoteCompact.EncryptedContentStore.get(sessionID)).toBeUndefined()
      }).pipe(Effect.provide(Database.layerFromPath(file)))
    }),
  )
})
