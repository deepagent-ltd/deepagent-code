import { Database } from "bun:sqlite"
import { Effect } from "effect"
import { TestLLMServer } from "../../lib/llm-server"
import { pollWithTimeout } from "../../lib/effect"
import { check, isRecord } from "./assertions"
import { call } from "./backend"
import { http, route } from "./dsl"
import { exerciseDatabasePath } from "./environment"
import type { ScenarioContext, SessionInfo } from "./types"
import { activeModelSpans, completedModelSpans } from "./session-model-tracer"

export const modelServer = Effect.gen(function* () {
  const server = yield* Effect.serviceOption(TestLLMServer)
  if (server._tag === "None") return yield* Effect.die(new Error("model scenario needs its actual TestLLMServer"))
  return server.value
})

export function modelState(sessionID: string) {
  const db = new Database(exerciseDatabasePath, { readonly: true })
  try {
    return {
      session: db
        .query<
          { execution_claim_token: number | null },
          [string]
        >("SELECT execution_claim_token FROM session WHERE id=?")
        .get(sessionID),
      inputs: db
        .query<
          { id: string; delivery: string; promoted_seq: number | null },
          [string]
        >("SELECT id,delivery,promoted_seq FROM session_input WHERE session_id=? ORDER BY admitted_seq")
        .all(sessionID),
      messages: db
        .query<
          { id: string; type: string; data: string },
          [string]
        >("SELECT id,type,data FROM session_message WHERE session_id=? ORDER BY seq")
        .all(sessionID),
      receipts: db
        .query<
          { receipt_id: string; provider_id: string; model_id: string; state: string },
          [string]
        >("SELECT receipt_id,provider_id,model_id,state FROM session_v2_provider_turn_receipt WHERE session_id=? ORDER BY request_ordinal")
        .all(sessionID),
      compactions: db
        .query<
          { status: string; provider_id: string; model_id: string; summary_receipt_id: string | null },
          [string]
        >("SELECT status,provider_id,model_id,summary_receipt_id FROM session_v2_compaction_request WHERE session_id=? ORDER BY created_at")
        .all(sessionID),
      activities: db
        .query<
          { state: string; final_message_id: string | null },
          [string]
        >("SELECT state,final_message_id FROM session_activity WHERE session_id=? ORDER BY ordinal")
        .all(sessionID),
      events: db
        .query<
          { type: string; seq: number },
          [string]
        >("SELECT type,seq FROM event WHERE aggregate_id=? ORDER BY seq DESC LIMIT 8")
        .all(sessionID),
    }
  } finally {
    db.close()
  }
}

export function modelDiagnostic(ctx: ScenarioContext, sessionID: SessionInfo["id"], stage: string) {
  return Effect.gen(function* () {
    const state = modelState(sessionID)
    const background = yield* Effect.sync(() => {
      const db = new Database(exerciseDatabasePath, { readonly: true })
      try {
        return db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type='table' AND (name GLOB 'work_*' OR name GLOB 'durable_learning_*' OR name GLOB '*outbox*') ORDER BY name",
          )
          .all()
          .map((table) => ({
            table: table.name,
            count: db.query<{ n: number }, []>(`SELECT count(*) n FROM "${table.name}"`).get()?.n,
          }))
      } finally {
        db.close()
      }
    })
    console.info("HTTPAPI_MODEL_STAGE", {
      stage,
      coordinatorActive: yield* ctx.sessionExecutionActive(sessionID),
      claimActive: state.session?.execution_claim_token !== null,
      inputs: state.inputs,
      activities: state.activities,
      receipts: state.receipts,
      compactions: state.compactions,
      events: state.events,
      background,
      messages: state.messages.map((message) => ({ id: message.id, type: message.type })),
    })
    console.info("HTTPAPI_MODEL_ACTIVE_SPANS", activeModelSpans())
    console.info("HTTPAPI_MODEL_COMPLETED_SPANS", completedModelSpans())
    const server = yield* modelServer
    console.info("HTTPAPI_MODEL_UPSTREAM", {
      calls: yield* server.calls,
      pending: yield* server.pending,
      misses: (yield* server.misses).length,
    })
    if (ctx.directory) {
      const child = Bun.spawn(["git", "ls-files", "--others", "--exclude-standard", "-z"], {
        cwd: ctx.directory,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [output, code] = yield* Effect.promise(() => Promise.all([new Response(child.stdout).text(), child.exited]))
      const files = output.split("\0").filter(Boolean)
      console.info("HTTPAPI_MODEL_OWNED_UNTRACKED", {
        code,
        count: files.length,
        first: files.slice(0, 12),
        prefixes: Object.fromEntries(
          Array.from(new Set(files.map((file) => file.split("/")[0]))).map((prefix) => [
            prefix,
            files.filter((file) => file.split("/")[0] === prefix).length,
          ]),
        ),
      })
    }
  })
}

export function modelRequest(server: Effect.Success<typeof modelServer>, needle: string, after = 0) {
  return Effect.gen(function* () {
    const inputs = yield* server.inputs
    check(
      inputs
        .slice(after)
        .some(
          (input) =>
            input.model === "test-model" &&
            Array.isArray(input.messages) &&
            input.messages.some(
              (message) =>
                isRecord(message) && message.role === "user" && JSON.stringify(message.content).includes(needle),
            ),
        ),
      `the actual upstream model request must contain its original user input: ${needle}`,
    )
  })
}

export function settledReply(ctx: ScenarioContext, session: SessionInfo, text: string) {
  return Effect.gen(function* () {
    const waited = yield* call(
      { ...sessionWait, request: () => ({ path: `/api/session/${session.id}/wait`, headers: ctx.headers() }) },
      { ...ctx, state: undefined },
    ).pipe(Effect.timeout("10 seconds"), Effect.orDie)
    check(
      waited.status === 204,
      `the original public wait endpoint must finish the model drain: ${waited.status}: ${waited.text}`,
    )
    return yield* pollWithTimeout(
      ctx.messages(session.id).pipe(
        Effect.map((messages) => {
          const assistant = messages.find(
            (message) =>
              message.info.role === "assistant" &&
              message.info.time.completed !== undefined &&
              message.parts.some((part) => part.type === "text" && part.text === text),
          )
          const state = modelState(session.id)
          return assistant &&
            state.session?.execution_claim_token === null &&
            state.receipts.length === state.inputs.length &&
            state.receipts.every(
              (receipt) =>
                receipt.state === "settled" && receipt.provider_id === "test" && receipt.model_id === "test-model",
            )
            ? assistant
            : undefined
        }),
      ),
      "the original model response and its durable provider receipt did not settle",
      "10 seconds",
    ).pipe(Effect.orDie)
  }).pipe(
    Effect.tapCause(() =>
      modelDiagnostic(ctx, session.id, "reply-not-idle").pipe(Effect.catchCause(() => Effect.void)),
    ),
  )
}

const sessionWait = http.protected.post("/api/session/{sessionID}/wait", "fixture.modelDrainWait").status(204)

const canonicalPrompt = http.protected
  .post("/session/{sessionID}/prompt_async", "fixture.canonicalSummaryHistory")
  .json(200)

export function canonicalHistory(ctx: ScenarioContext, session: SessionInfo) {
  return Effect.gen(function* () {
    const server = yield* modelServer
    const release = Promise.withResolvers<void>()
    yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
    // Keep the second real turn active until the public compact endpoint has
    // durably admitted its request. Its wake must join the existing drain.
    for (const turn of [1, 2]) {
      if (turn === 1) yield* server.text(`original canonical work ${turn} completed`)
      if (turn === 2) yield* server.hold(`original canonical work ${turn} completed`, release.promise)
      const scenario = {
        ...canonicalPrompt,
        request: () => ({
          path: route("/session/{sessionID}/prompt_async", { sessionID: session.id }),
          headers: ctx.headers(),
          body: {
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: `canonical summarize work ${turn}` }],
          },
        }),
      }
      const admitted = yield* call(scenario, { ...ctx, state: undefined })
      check(
        admitted.status === 200 && isRecord(admitted.body) && admitted.body.delivery === "steer",
        `canonical history admission failed: ${admitted.status}: ${admitted.text}`,
      )
      if (turn === 1) yield* settledReply(ctx, session, `original canonical work ${turn} completed`)
      yield* pollWithTimeout(
        server.inputs.pipe(
          Effect.map((inputs) =>
            inputs.some((input) => JSON.stringify(input.messages).includes(`canonical summarize work ${turn}`))
              ? true
              : undefined,
          ),
        ),
        "canonical history did not reach its actual upstream provider",
        "10 seconds",
      ).pipe(Effect.orDie)
      yield* modelRequest(server, `canonical summarize work ${turn}`)
    }
    const state = modelState(session.id)
    check(
      state.session?.execution_claim_token !== null && (yield* ctx.sessionExecutionActive(session.id)),
      "the second original provider turn must still own its execution lane before compaction",
    )
    check(
      state.inputs.length === 2 && state.inputs.every((input) => input.promoted_seq !== null),
      "history must cross its original durable admission and promotion boundary",
    )
    const compactAdmission = yield* pollWithTimeout(
      Effect.sync(() => {
        const observed = modelState(session.id)
        return observed.compactions.length === 1 ? observed : undefined
      }),
      "the public compact endpoint did not durably admit its request while the original turn was active",
      "10 seconds",
    ).pipe(
      Effect.tap((observed) =>
        Effect.gen(function* () {
          check(
            observed.compactions[0]?.status === "pending",
            "compaction must remain pending while the original provider turn is active",
          )
          check(
            observed.receipts.length === 2 &&
              observed.inputs.length === 2 &&
              observed.session?.execution_claim_token !== null,
            "compaction admission must retain the original model turn and must not dispatch another provider turn",
          )
          const inputs = yield* server.inputs
          check(
            inputs.length === 2,
            "the original two history turns must each dispatch exactly once before releasing compaction",
          )
        }),
      ),
      Effect.ensuring(Effect.sync(() => release.resolve())),
      Effect.orDie,
      Effect.forkScoped,
    )
    return { server, compactAdmission }
  })
}

export function idleModelSession(ctx: ScenarioContext, session: SessionInfo) {
  return Effect.gen(function* () {
    const waited = yield* call(
      { ...sessionWait, request: () => ({ path: `/api/session/${session.id}/wait`, headers: ctx.headers() }) },
      { ...ctx, state: undefined },
    ).pipe(Effect.timeout("10 seconds"), Effect.orDie)
    check(waited.status === 204, `the public wait endpoint did not finish the model drain: ${waited.status}`)
    yield* pollWithTimeout(
      ctx
        .sessionExecutionActive(session.id)
        .pipe(
          Effect.map((active) =>
            !active && modelState(session.id).session?.execution_claim_token === null ? true : undefined,
          ),
        ),
      "the canonical model drain did not release its original execution claim",
      "10 seconds",
    ).pipe(Effect.orDie)
  })
}
