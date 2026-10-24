import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LLM } from "@deepagent-code/llm"
import { Auth } from "@deepagent-code/llm/route"
import { OpenAIResponses } from "@deepagent-code/llm/protocols/openai-responses"
import { Database } from "../src/database/database"
import { SessionContext } from "../src/context-federation/session-context"
import { SessionProviderOwner } from "../src/context-federation/provider-owner"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { Prompt } from "../src/session/prompt"
import { RemoteCompaction } from "../src/session/remote-compaction"
import { SessionMessage } from "../src/session/message"
import { SessionContextUsage } from "../src/session/context-usage"
import { SessionSchema } from "../src/session/schema"
import { SessionInputTable, SessionTable } from "../src/session/sql"
import { SessionRunnerCanonical } from "../src/session/runner/canonical-turn"
import { V2ProviderTurn } from "../src/session/runner/v2-provider-turn"
import { V2ProviderTurnReceiptTable } from "../src/session/runner/v2-provider-turn.sql"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const owners = SessionProviderOwner.layer.pipe(Layer.provide(database))
const turns = V2ProviderTurn.layer.pipe(Layer.provide(owners), Layer.provide(database))
const contexts = SessionContext.layer.pipe(
  Layer.provide(SessionRunnerCanonical.degradedArtifactStore),
  Layer.provide(database),
)
const authorization = Layer.succeed(
  V2ProviderTurn.OwnerAuthorization,
  V2ProviderTurn.OwnerAuthorization.of({
    authorize: () => Effect.succeed(true),
  }),
)
const it = testEffect(Layer.mergeAll(database, owners, turns, contexts, authorization))
const sessionID = SessionSchema.ID.make("ses_remote_compaction_dispatch")
const userMessageID = SessionMessage.ID.make("msg_remote_compaction_dispatch")
const model = OpenAIResponses.route
  .with({
    auth: Auth.bearer("fixture-only"),
    limits: { context: 1_000_000, output: 64_000 },
  })
  .model({ id: "gpt-6.1-sol" })
const output = [
  { type: "message", role: "user", content: [{ type: "input_text", text: "retained input" }] },
  { type: "compaction", id: "cmp_fixture", encrypted_content: "opaque-fixture", additional_field: { preserved: true } },
]

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "compact",
      directory: "/project",
      title: "remote compact fixture",
      version: "test",
      execution_claim_token: 104,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionInputTable)
    .values({
      id: userMessageID,
      session_id: sessionID,
      admitted_seq: 1,
      prompt: new Prompt({ text: "retain the task" }),
      delivery: "steer",
      promoted_seq: 1,
      time_created: 1,
    })
    .run()
    .pipe(Effect.orDie)
  const contexts = yield* SessionContext.Service
  const providerTurns = yield* V2ProviderTurn.Service
  const admission = yield* SessionRunnerCanonical.admitSelection({
    db,
    contexts,
    sessionID,
    agent: "build",
    location: { directory: "/project" },
    promotedInputIds: [userMessageID],
    system: { baseline: "baseline", revision: 0, baselineSeq: 1 },
    historyEndMessageId: userMessageID,
  })
  return {
    db,
    compact: RemoteCompaction.make({ db, contexts, providerTurns }),
    input: {
      sessionID,
      userMessageID,
      historyPromptEpoch: 0,
      ownerMode: "v2" as const,
      admission,
      model,
      mode: "adaptive" as const,
      request: LLM.request({ model, system: "preserve constraints", prompt: "retain the task" }),
      summaryPrompt: "unused remote summary",
    },
  }
})

// Standard Effect HTTP fixture context only: no global fetch replacement and no provider network call.
const http = (respond: (url: string, init?: RequestInit) => Promise<Response>) =>
  Object.assign(
    async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) =>
      respond(String(input), init),
    { preconnect: globalThis.fetch.preconnect },
  )

it.effect("production remote factory seals one durable compact request and replays the complete settled window", () =>
  Effect.gen(function* () {
    const fixture = yield* seed
    let calls = 0
    const sent: { url: string; method?: string; body: Record<string, unknown> }[] = []
    const fetch = http(async (url, init) => {
      calls++
      sent.push({ url, method: init?.method, body: (await new Response(init?.body).json()) as Record<string, unknown> })
      return Response.json({
        output,
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          input_tokens_details: { cached_tokens: 20 },
          output_tokens_details: { reasoning_tokens: 4 },
        },
      })
    })
    const result = yield* fixture.compact(fixture.input).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch))
    expect(result).toMatchObject({ kind: "remote_window", window: { output } })
    expect(sent[0]?.url).toBe("https://api.openai.com/v1/responses/compact")
    expect(sent[0]?.method).toBe("POST")
    expect(Object.keys(sent[0]!.body).sort()).toEqual(["input", "instructions", "model"])
    expect(sent[0]?.body.model).toBe("gpt-6.1-sol")
    expect(yield* fixture.compact(fixture.input).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch))).toEqual(
      result,
    )
    expect(calls).toBe(1)
    const receipts = yield* fixture.db
      .select()
      .from(V2ProviderTurnReceiptTable)
      .where(eq(V2ProviderTurnReceiptTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ state: "settled", provider_id: "openai", model_id: "gpt-6.1-sol" })
    expect(receipts[0]?.wire_request_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(receipts[0]?.prepared_turn?.budget).toMatchObject({ decision: "ok", reservedOutputTokens: 0 })
    expect(receipts[0]?.outcome_artifact?.[0]).toMatchObject({ kind: "remote_window", window: { output } })
    expect(receipts[0]?.outcome_artifact?.[1]).toMatchObject({
      type: "step-finish",
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        nonCachedInputTokens: 80,
        cacheReadInputTokens: 20,
        reasoningTokens: 4,
      },
    })
    const usage = yield* SessionContextUsage.read(fixture.db, {
      sessionID,
      projectID: Project.ID.global,
      directory: "/project",
      draftRevision: "fixture",
    })
    expect(usage.activity?.tokens).toEqual({
      nonCachedInput: 80,
      cacheRead: 20,
      cacheWrite: 0,
      output: 6,
      reasoning: 4,
    })
    expect(usage.totals).toEqual({ nonCachedInput: 80, cacheRead: 20, cacheWrite: 0, output: 6, reasoning: 4 })
  }),
)

it.effect("an unknown compact transport outcome is quarantined and a repeated identity never dispatches again", () =>
  Effect.gen(function* () {
    const fixture = yield* seed
    let calls = 0
    const fetch = http(async () => {
      calls++
      throw new Error("fixture reset after request dispatch")
    })
    expect(
      (yield* fixture.compact(fixture.input).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.exit))
        ._tag,
    ).toBe("Failure")
    const receipt = yield* fixture.db
      .select()
      .from(V2ProviderTurnReceiptTable)
      .where(eq(V2ProviderTurnReceiptTable.session_id, sessionID))
      .get()
      .pipe(Effect.orDie)
    expect(receipt?.state).toBe("indeterminate_after_crash")
    expect(receipt?.error_code).toStartWith("compaction_stream_failed:")
    expect(receipt?.dispatching_at).not.toBeNull()
    expect(
      yield* fixture.compact(fixture.input).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
    ).toMatchObject({ kind: "recovery_required" })
    expect(calls).toBe(1)
  }),
)

for (const status of [401, 404, 405, 501]) {
  it.effect(
    `HTTP ${status} ${status === 405 || status === 501 ? "is a definitive endpoint refusal" : "does not permit local fallback"}`,
    () =>
      Effect.gen(function* () {
        const fixture = yield* seed
        let calls = 0
        const fetch = http(async () => {
          calls++
          return Response.json({ error: { message: "fixture endpoint refusal" } }, { status })
        })
        const first = yield* fixture
          .compact(fixture.input)
          .pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.exit)
        if (status === 405 || status === 501)
          expect(first).toMatchObject({ _tag: "Success", value: { kind: "not_supported" } })
        if (status === 401 || status === 404) expect(first._tag).toBe("Failure")
        const receipt = yield* fixture.db
          .select()
          .from(V2ProviderTurnReceiptTable)
          .where(eq(V2ProviderTurnReceiptTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie)
        expect(receipt?.state).toBe(
          status === 405 || status === 501 ? "settled" : status === 401 ? "failed" : "indeterminate_after_crash",
        )
        const second = yield* fixture.compact(fixture.input).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch))
        expect(second.kind).toBe(status === 405 || status === 501 ? "not_supported" : "recovery_required")
        expect(calls).toBe(1)
      }),
  )
}

it.effect("physical, economic and model-binding refusals create no receipt or HTTP dispatch", () =>
  Effect.gen(function* () {
    const fixture = yield* seed
    let calls = 0
    const fetch = http(async () => {
      calls++
      throw new Error("budget refusal must not dispatch")
    })
    const economical = { ...fixture.input, request: LLM.request({ model, prompt: "x".repeat(1_200_000) }) }
    expect(yield* fixture.compact(economical).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch))).toMatchObject({
      kind: "unavailable",
      reason: "remote_compaction_working_budget_exceeded",
    })
    const small = OpenAIResponses.route
      .with({ auth: Auth.bearer("fixture-only"), limits: { context: 20_000, output: 1_000 } })
      .model({ id: model.id })
    expect(
      yield* fixture
        .compact({
          ...fixture.input,
          model: small,
          request: LLM.request({ model: small, prompt: "x".repeat(100_000) }),
        })
        .pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
    ).toMatchObject({ kind: "unavailable", reason: "remote_input_budget_unavailable" })
    expect(
      yield* fixture
        .compact({ ...fixture.input, model: small })
        .pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
    ).toMatchObject({ kind: "unavailable" })
    expect(calls).toBe(0)
    expect(yield* fixture.db.select().from(V2ProviderTurnReceiptTable).all().pipe(Effect.orDie)).toEqual([])
  }),
)
