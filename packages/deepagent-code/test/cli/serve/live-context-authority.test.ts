import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import {
  loadLiveLLMConfig,
  modelFingerprint,
  preflightLiveLLM,
  writeLiveArtifact,
} from "../../../../llm/script/live-llm/config"
import { liveWorkspaceConfig, runtimeProviderIDFor } from "../../../script/live-llm/runtime"
import { cliIt } from "../../lib/cli-process"

type JsonResult = {
  readonly status: number
  readonly body: unknown
}

const enabled = process.env.DEEPAGENT_CODE_LIVE_CONTEXT_AUTHORITY === "1"

if (!enabled) {
  test.skip("DeepSeek context authority gate requires DEEPAGENT_CODE_LIVE_CONTEXT_AUTHORITY=1", () => {})
} else {
  cliIt.live(
    "preserves compacted context authority through DeepSeek fork, restart, and corruption fencing",
    ({ deepagentCode, home }) =>
      Effect.gen(function* () {
        const startedAt = Date.now()
        const config = yield* Effect.promise(() => loadLiveLLMConfig())
        const preflight = yield* Effect.promise(() => preflightLiveLLM(config))
        const providerID = runtimeProviderIDFor(config)
        const databaseName = "live-context-authority.db"
        const databasePath = path.join(home, ".deepagent", "code", databaseName)
        const workspace = path.join(home, "workspace")
        const marker = `world-state-${crypto.randomUUID()}.txt`
        yield* Effect.promise(() => mkdir(workspace, { recursive: true }))
        const initialized = yield* Effect.promise(
          () => Bun.spawn(["git", "init", "--quiet"], { cwd: workspace }).exited,
        )
        expect(initialized).toBe(0)
        yield* Effect.promise(() => Bun.write(path.join(workspace, marker), "committed context authority marker\n"))
        const committed = yield* Effect.promise(async () => {
          const added = await Bun.spawn(["git", "add", marker], { cwd: workspace }).exited
          if (added !== 0) return added
          return Bun.spawn(
            [
              "git",
              "-c",
              "user.name=DeepAgent Live Gate",
              "-c",
              "user.email=live-gate@invalid",
              "commit",
              "--quiet",
              "-m",
              "fixture",
            ],
            { cwd: workspace },
          ).exited
        })
        expect(committed).toBe(0)
        yield* Effect.promise(() => Bun.write(path.join(workspace, marker), "modified context authority marker\n"))

        const runtimeConfig = {
          ...liveWorkspaceConfig(config, { "*": "deny" }, { "*": "deny" }, undefined, {
            primaryPrompt:
              "This is a context-authority verification. Follow the current instruction exactly and do not call tools.",
            modelMaxTokens: 256,
            maxProviderTurns: 3,
          }),
          formatter: false,
          lsp: false,
          compaction: { tail_turns: 1, preserve_recent_tokens: 1_000, prune: false },
        }
        const serverOptions = {
          hostname: "127.0.0.1",
          readyTimeoutMs: 30_000,
          env: {
            DEEPAGENT_CODE_DB: databaseName,
            DEEPAGENT_CODE_CONFIG_CONTENT: JSON.stringify(runtimeConfig),
            DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE: config.apiKeyFile,
            DEEPAGENT_CODE_DISABLE_AUTOCOMPACT: "1",
            DEEPAGENT_CODE_ASSEMBLED_REQUEST_FINGERPRINT: "1",
            DEEPAGENT_ENABLED: "false",
            DEEPAGENT_MODE: "general",
          },
        }
        const headers = {
          "content-type": "application/json",
          "x-deepagent-code-directory": workspace,
        }
        const promptBody = (text: string) =>
          JSON.stringify({
            agent: "live-test",
            model: { providerID, modelID: config.modelID },
            parts: [{ type: "text", text }],
          })

        const first = yield* deepagentCode.serve(serverOptions)
        expect((yield* requestJson(first.url, "/global/health", {}, config.timeoutMs)).status).toBe(200)

        const created = yield* requestJson(
          first.url,
          "/session",
          {
            method: "POST",
            headers,
            body: JSON.stringify({ title: "DeepSeek context authority" }),
          },
          config.timeoutMs,
        )
        expect(created.status).toBe(200)
        const parentID = stringField(created.body, "id", "created Session")

        for (const prompt of ["Reply only FIRST_CONTEXT_OK.", "Reply only RETAINED_CONTEXT_OK."]) {
          const response = yield* requestJson(
            first.url,
            `/session/${parentID}/message`,
            { method: "POST", headers, body: promptBody(prompt) },
            config.timeoutMs * 2,
          )
          expect(response.status).toBe(200)
          expect(assistantSucceeded(response.body)).toBe(true)
        }

        const summarized = yield* requestJson(
          first.url,
          `/session/${parentID}/summarize`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ providerID, modelID: config.modelID, auto: false }),
          },
          config.timeoutMs * 2,
        )
        expect(summarized.status).toBe(200)
        expect(summarized.body).toBe(true)

        const compactedMessages = yield* requestJson(
          first.url,
          `/session/${parentID}/message`,
          { headers },
          config.timeoutMs,
        )
        expect(compactedMessages.status).toBe(200)
        const contextTokens = compactionContextTokens(compactedMessages.body)
        expect(contextTokens).toBeGreaterThan(0)
        const compactedParent = readAuthority(databasePath, parentID)
        const parentActive = requireActive(compactedParent, parentID)
        expect(parentActive.epoch).toBe(1)
        expect(parentActive.authority_state).toBe("ready")
        expect(parentActive.world_state_baseline_hash).toMatch(/^wsb1_/)
        expect(compactedParent.baselines.length).toBeGreaterThan(0)
        expect(compactedParent.baselines.some((row) => row.fragment.includes(marker))).toBe(true)
        expect(compactedParent.physicalMessageCount).toBeGreaterThan(parentActive.base_message_count ?? 0)

        const manualNext = yield* requestJson(
          first.url,
          `/session/${parentID}/message`,
          {
            method: "POST",
            headers,
            body: promptBody("Reply only MANUAL_WINDOW_OK."),
          },
          config.timeoutMs * 2,
        )
        expect(manualNext.status).toBe(200)
        expect(assistantSucceeded(manualNext.body)).toBe(true)
        const parentReceipt = latestReceipt(databasePath, parentID)
        expect(parentReceipt.request_state).toBe("dispatched")
        expect(parentReceipt.provider_id).toBe(providerID)
        expect(parentReceipt.model_id).toBe(config.modelID)
        expect(parentReceipt.prompt_epoch).toBe(parentActive.epoch)
        expect(parentReceipt.prompt_window_id).toBe(parentActive.window_id)
        expect(parentReceipt.world_state_baseline_hash).toBe(parentActive.world_state_baseline_hash)
        expect(parentReceipt.effective_history_hash).toBeTruthy()
        expect(parentReceipt.provider_request_hash).toBeTruthy()
        expect(parentReceipt.estimated_input_tokens).toBeGreaterThan(0)
        expect(parentReceipt.prompt_cache_key).toBeNull()
        expect(parentReceipt.response_chain_reuse_decision).toBe("not_supported")
        expect(parentReceipt.response_chain_refusal_reason).toBe("provider_path_not_stateful")

        const forked = yield* requestJson(
          first.url,
          `/session/${parentID}/fork`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ intentID: "live-context-authority-foreground" }),
          },
          config.timeoutMs,
        )
        expect(forked.status).toBe(200)
        const childID = stringField(forked.body, "id", "forked Session")
        const childBeforePrompt = readAuthority(databasePath, childID)
        const childActive = requireActive(childBeforePrompt, childID)
        const forkIntent = readForkIntent(databasePath, "live-context-authority-foreground")
        expect(forkIntent.state).toBe("complete")
        expect(forkIntent.side_effects_completed_at).toEqual(expect.any(Number))
        expect(forkIntent.source_message_count).toBe(forkIntent.cloned_message_count)
        expect(forkIntent.cloned_message_count).toBe(childBeforePrompt.physicalMessageCount)
        expect(forkIntent.target_effective_history_hash).toBe(childActive.effective_history_hash)
        expect(forkIntent.target_world_state_baseline_hash).toBe(childActive.world_state_baseline_hash)
        expect(forkIntent.source_window_id).toBe(parentActive.window_id)
        expect(forkIntent.target_window_id).not.toBe(forkIntent.source_window_id)
        expect(childActive.authority_state).toBe("ready")
        expect(childBeforePrompt.membershipCount).toBe(forkIntent.cloned_message_count)

        const childFirstTurn = yield* requestJson(
          first.url,
          `/session/${childID}/message`,
          {
            method: "POST",
            headers,
            body: promptBody("Reply only FORK_WINDOW_OK."),
          },
          config.timeoutMs * 2,
        )
        expect(childFirstTurn.status).toBe(200)
        expect(assistantSucceeded(childFirstTurn.body)).toBe(true)
        const childReceipt = latestReceipt(databasePath, childID)
        expect(childReceipt.request_state).toBe("dispatched")
        expect(childReceipt.provider_id).toBe(providerID)
        expect(childReceipt.prompt_epoch).toBe(childActive.epoch)
        expect(childReceipt.prompt_window_id).toBe(childActive.window_id)
        expect(childReceipt.world_state_baseline_hash).toBe(childActive.world_state_baseline_hash)
        expect(childReceipt.prompt_cache_key).toBeNull()
        expect(childReceipt.provider_request_hash).toBeTruthy()

        const malformedFork = yield* requestJson(
          first.url,
          `/session/${parentID}/fork`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ intentID: "live-context-authority-malformed" }),
          },
          config.timeoutMs,
        )
        expect(malformedFork.status).toBe(200)
        const malformedID = stringField(malformedFork.body, "id", "malformed fixture Session")
        expect(receiptCount(databasePath, malformedID)).toBe(0)

        const childMessagesBeforeRestart = yield* requestText(
          first.url,
          `/session/${childID}/message`,
          { headers },
          config.timeoutMs,
        )
        expect(childMessagesBeforeRestart.status).toBe(200)
        const childAuthorityBeforeRestart = readAuthority(databasePath, childID)
        const childActiveBeforeRestart = requireActive(childAuthorityBeforeRestart, childID)
        first.kill()
        yield* Effect.promise(() => first.exited)

        corruptMembership(databasePath, malformedID)
        const malformedBeforeDispatch = receiptCount(databasePath, malformedID)
        const second = yield* deepagentCode.serve(serverOptions)
        expect((yield* requestJson(second.url, "/global/health", {}, config.timeoutMs)).status).toBe(200)

        const childMessagesAfterRestart = yield* requestText(
          second.url,
          `/session/${childID}/message`,
          { headers },
          config.timeoutMs,
        )
        expect(childMessagesAfterRestart.status).toBe(200)
        expect(childMessagesAfterRestart.body).toBe(childMessagesBeforeRestart.body)
        expect(readAuthority(databasePath, childID)).toEqual(childAuthorityBeforeRestart)

        const malformedPrompt = yield* requestText(
          second.url,
          `/session/${malformedID}/message`,
          {
            method: "POST",
            headers,
            body: promptBody("This request must fail before Provider dispatch."),
          },
          config.timeoutMs,
        )
        expect(malformedPrompt.status).toBeGreaterThanOrEqual(400)
        expect(receiptCount(databasePath, malformedID)).toBe(malformedBeforeDispatch)
        const malformedAuthority = readAuthority(databasePath, malformedID)
        const malformedActive = requireActive(malformedAuthority, malformedID)
        expect(malformedActive.authority_state).toBe("recovery_required")
        expect(malformedAuthority.historyState?.state).toBe("recovery_required")
        expect(malformedAuthority.historyState?.reason).toBeTruthy()

        const restartTurn = yield* requestJson(
          second.url,
          `/session/${childID}/message`,
          {
            method: "POST",
            headers,
            body: promptBody("Reply only RESTART_WINDOW_OK."),
          },
          config.timeoutMs * 2,
        )
        expect(restartTurn.status).toBe(200)
        expect(assistantSucceeded(restartTurn.body)).toBe(true)
        const restartReceipt = latestReceipt(databasePath, childID)
        expect(restartReceipt.request_ordinal).toBe(childReceipt.request_ordinal + 1)
        expect(restartReceipt.prompt_epoch).toBe(childActiveBeforeRestart.epoch)
        expect(restartReceipt.prompt_window_id).toBe(childActiveBeforeRestart.window_id)
        expect(restartReceipt.world_state_baseline_hash).toBe(childActiveBeforeRestart.world_state_baseline_hash)
        expect(restartReceipt.request_state).toBe("dispatched")

        const retry = yield* requestJson(
          second.url,
          `/session/${parentID}/fork`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ intentID: "live-context-authority-foreground" }),
          },
          config.timeoutMs,
        )
        expect(retry.status).toBe(200)
        expect(stringField(retry.body, "id", "retried fork")).toBe(childID)

        const finalChildSnapshot: unknown = JSON.parse(childMessagesAfterRestart.body)

        const evidence = {
          suite: "context-authority-live",
          mode: "ext" as const,
          stack: "cli-subprocess" as const,
          status: "passed" as const,
          fingerprint: { ...modelFingerprint(config), runtimeProviderID: providerID },
          preflight: { durationMs: preflight.durationMs },
          evidence: {
            manual: {
              promptEpoch: parentActive.epoch,
              contextTokens,
              windowID: parentActive.window_id,
              worldStateBaselineHash: parentActive.world_state_baseline_hash,
              requestReceiptID: parentReceipt.receipt_id,
              requestHash: parentReceipt.provider_request_hash,
              providerDispatches: receiptCount(databasePath, parentID),
            },
            foregroundFork: {
              intentID: forkIntent.intent_id,
              targetSessionID: childID,
              sourceMessageCount: forkIntent.source_message_count,
              clonedMessageCount: forkIntent.cloned_message_count,
              sourceWindowID: forkIntent.source_window_id,
              targetWindowID: forkIntent.target_window_id,
              firstRequestReceiptID: childReceipt.receipt_id,
              restartRequestReceiptID: restartReceipt.receipt_id,
              promptCacheKeySent: childReceipt.prompt_cache_key,
            },
            malformed: {
              sessionID: malformedID,
              responseStatus: malformedPrompt.status,
              providerDispatchesBefore: malformedBeforeDispatch,
              providerDispatchesAfter: receiptCount(databasePath, malformedID),
              authorityState: malformedActive.authority_state,
              recoveryReason: malformedAuthority.historyState?.reason,
            },
            restart: {
              messagesByteIdentical: childMessagesAfterRestart.body === childMessagesBeforeRestart.body,
              epoch: childActiveBeforeRestart.epoch,
              windowID: childActiveBeforeRestart.window_id,
              effectiveHistoryHash: childActiveBeforeRestart.effective_history_hash,
              exactForkRetryAdopted: true,
            },
            authority: {
              parentAfterCompaction: compactedParent,
              childBeforeRestart: childAuthorityBeforeRestart,
              malformedAfterCorruption: malformedAuthority,
            },
            forkIntent,
            requestReceipts: {
              parentAfterCompaction: parentReceipt,
              childFirstTurn: childReceipt,
              childRestartTurn: restartReceipt,
            },
            snapshots: {
              compactionTimeline: compactedMessages.body,
              compactionTimelineSha256: sha256Json(compactedMessages.body),
              finalChild: finalChildSnapshot,
              finalChildSha256: sha256Json(finalChildSnapshot),
            },
            dispatchCounts: {
              parent: receiptCount(databasePath, parentID),
              child: receiptCount(databasePath, childID),
              malformed: receiptCount(databasePath, malformedID),
            },
            worldStateMarkerHash: Bun.hash(marker).toString(16),
          },
          durationMs: Date.now() - startedAt,
          completedAt: new Date().toISOString(),
        }
        yield* Effect.promise(() =>
          writeLiveArtifact(config, evidence.suite, evidence, {
            redactions: [{ value: marker, replacement: `<world-state-marker hash=${Bun.hash(marker).toString(16)}>` }],
            harnessFiles: [
              "packages/deepagent-code/test/cli/serve/live-context-authority.test.ts",
              "packages/deepagent-code/script/live-llm/context-authority.ts",
              "packages/deepagent-code/script/live-llm/routes.ts",
              "packages/deepagent-code/script/live-llm/runtime.ts",
              "packages/llm/script/live-llm/config.ts",
            ],
            oracleVersion: "bug-012-context-authority-v2",
          }),
        )
        second.kill()
        yield* Effect.promise(() => second.exited)
      }),
    { timeout: 10 * 60_000 },
  )
}

function requestJson(base: string, requestPath: string, init: RequestInit, timeoutMs: number) {
  return Effect.promise(async () => {
    const response = await fetch(`${base}${requestPath}`, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    const body: unknown = await response.json()
    return { status: response.status, body } satisfies JsonResult
  })
}

function requestText(base: string, requestPath: string, init: RequestInit, timeoutMs: number) {
  return Effect.promise(async () => {
    const response = await fetch(`${base}${requestPath}`, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    return { status: response.status, body: await response.text() }
  })
}

function stringField(value: unknown, field: string, label: string) {
  if (!isRecord(value) || typeof value[field] !== "string") throw new Error(`${label} has no ${field}`)
  return value[field]
}

function assistantSucceeded(value: unknown) {
  if (!isRecord(value) || !isRecord(value.info) || !isRecord(value.info.time)) return false
  return (
    value.info.role === "assistant" && value.info.error === undefined && typeof value.info.time.completed === "number"
  )
}

function compactionContextTokens(value: unknown) {
  if (!Array.isArray(value)) throw new Error("Session messages response is not an array")
  const marker = value
    .flatMap((message) => (isRecord(message) && Array.isArray(message.parts) ? message.parts : []))
    .find((part) => isRecord(part) && part.type === "compaction")
  if (!isRecord(marker) || typeof marker.context_tokens !== "number") {
    throw new Error("Committed compaction marker has no context_tokens")
  }
  return marker.context_tokens
}

function readAuthority(databasePath: string, sessionID: string) {
  const database = new Database(databasePath, { readonly: true })
  const epochs = database
    .query(
      `SELECT epoch, state, authority_state, recovery_reason, base_message_count,
              effective_history_hash, first_window_id, previous_window_id, window_id,
              world_state_baseline_hash, source_end_message_id
         FROM session_prompt_epoch
        WHERE session_id = ?
        ORDER BY epoch`,
    )
    .all(sessionID) as Array<{
    epoch: number
    state: string
    authority_state: string | null
    recovery_reason: string | null
    base_message_count: number | null
    effective_history_hash: string | null
    first_window_id: string | null
    previous_window_id: string | null
    window_id: string | null
    world_state_baseline_hash: string | null
    source_end_message_id: string | null
  }>
  const active = epochs.find((row) => row.state === "active")
  const membershipCount = active
    ? (
        database
          .query(
            `SELECT COUNT(*) AS count
               FROM session_prompt_epoch_message
              WHERE session_id = ? AND prompt_epoch = ?`,
          )
          .get(sessionID, active.epoch) as { count: number }
      ).count
    : 0
  const physicalMessageCount = (
    database.query("SELECT COUNT(*) AS count FROM message WHERE session_id = ?").get(sessionID) as { count: number }
  ).count
  const baselines = database
    .query(
      `SELECT prompt_epoch, section_id, fragment, fragment_hash, provenance
         FROM session_world_state_baseline
        WHERE session_id = ?
        ORDER BY prompt_epoch, section_id`,
    )
    .all(sessionID) as Array<{
    prompt_epoch: number
    section_id: string
    fragment: string
    fragment_hash: string
    provenance: string
  }>
  const historyState = database
    .query("SELECT state, reason FROM session_history_state WHERE session_id = ?")
    .get(sessionID) as { state: string; reason: string | null } | null
  database.close()
  return { epochs, active, membershipCount, physicalMessageCount, baselines, historyState }
}

function requireActive(snapshot: ReturnType<typeof readAuthority>, sessionID: string) {
  if (!snapshot.active) throw new Error(`Session ${sessionID} has no active PromptEpoch`)
  if (
    snapshot.active.base_message_count === null ||
    !snapshot.active.effective_history_hash ||
    !snapshot.active.first_window_id ||
    !snapshot.active.window_id ||
    !snapshot.active.world_state_baseline_hash
  ) {
    throw new Error(`Session ${sessionID} has incomplete active PromptEpoch authority`)
  }
  return {
    ...snapshot.active,
    base_message_count: snapshot.active.base_message_count,
    effective_history_hash: snapshot.active.effective_history_hash,
    first_window_id: snapshot.active.first_window_id,
    window_id: snapshot.active.window_id,
    world_state_baseline_hash: snapshot.active.world_state_baseline_hash,
  }
}

function latestReceipt(databasePath: string, sessionID: string) {
  const database = new Database(databasePath, { readonly: true })
  const receipt = database
    .query(
      `SELECT receipt_id, request_ordinal, provider_id, model_id, prompt_epoch, prompt_window_id,
              effective_history_hash, world_state_baseline_hash, prompt_cache_key, provider_request_hash,
              response_chain_reuse_decision, response_chain_refusal_reason, estimated_input_tokens,
              request_input_hash, final_request_hash, protocol, registry_tool_ids,
              permission_filtered_tool_ids, final_offered_tool_ids, tool_definition_hash,
              adapter_tool_capability, adapter_lowering_outcome, physical_input_budget,
              reserved_output_tokens, safety_margin_tokens, context_limit_provenance,
              provider_state, adapter_prepared_at, dispatching_at, streaming_at, terminal_at,
              response_fingerprint, request_error_code, request_state, created_at
         FROM session_tool_request_receipt
        WHERE session_id = ?
        ORDER BY request_ordinal DESC
        LIMIT 1`,
    )
    .get(sessionID) as {
    receipt_id: string
    request_ordinal: number
    provider_id: string
    model_id: string
    prompt_epoch: number | null
    prompt_window_id: string | null
    effective_history_hash: string | null
    world_state_baseline_hash: string | null
    prompt_cache_key: string | null
    provider_request_hash: string | null
    response_chain_reuse_decision: string | null
    response_chain_refusal_reason: string | null
    estimated_input_tokens: number | null
    request_input_hash: string | null
    final_request_hash: string | null
    protocol: string | null
    registry_tool_ids: string
    permission_filtered_tool_ids: string
    final_offered_tool_ids: string
    tool_definition_hash: string | null
    adapter_tool_capability: string | null
    adapter_lowering_outcome: string | null
    physical_input_budget: number | null
    reserved_output_tokens: number | null
    safety_margin_tokens: number | null
    context_limit_provenance: string | null
    provider_state: string
    adapter_prepared_at: number | null
    dispatching_at: number | null
    streaming_at: number | null
    terminal_at: number | null
    response_fingerprint: string | null
    request_error_code: string | null
    request_state: string
    created_at: number
  } | null
  database.close()
  if (!receipt) throw new Error(`Session ${sessionID} has no Provider request receipt`)
  return receipt
}

function receiptCount(databasePath: string, sessionID: string) {
  const database = new Database(databasePath, { readonly: true })
  const row = database
    .query("SELECT COUNT(*) AS count FROM session_tool_request_receipt WHERE session_id = ?")
    .get(sessionID) as { count: number }
  database.close()
  return row.count
}

function sha256Json(value: unknown) {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")
}

function readForkIntent(databasePath: string, intentID: string) {
  const database = new Database(databasePath, { readonly: true })
  const intent = database
    .query(
      `SELECT intent_id, request_hash, fork_mode, state, source_session_id, source_prompt_epoch,
              source_effective_history_hash, source_mutation_epoch, source_cutoff_message_id,
              source_window_id, source_message_count, projection_version, sanitation_policy_version,
              target_session_id, target_prompt_epoch, target_window_id, cloned_message_count,
              cloned_part_count, target_effective_history_hash, target_world_state_baseline_hash,
              event_cursor, event_count, delivery_attempts, time_created, time_committed,
              time_completed, side_effects_completed_at
         FROM session_fork_intent
        WHERE intent_id = ?`,
    )
    .get(intentID) as {
    intent_id: string
    request_hash: string
    fork_mode: string
    state: string
    source_session_id: string
    source_prompt_epoch: number
    source_effective_history_hash: string
    source_mutation_epoch: number
    source_cutoff_message_id: string | null
    source_window_id: string
    source_message_count: number
    projection_version: number
    sanitation_policy_version: number
    target_session_id: string
    target_prompt_epoch: number
    target_window_id: string
    cloned_message_count: number
    cloned_part_count: number
    target_effective_history_hash: string
    target_world_state_baseline_hash: string
    event_cursor: number
    event_count: number
    delivery_attempts: number
    time_created: number
    time_committed: number | null
    time_completed: number | null
    side_effects_completed_at: number | null
  } | null
  database.close()
  if (!intent) throw new Error(`Fork intent ${intentID} is missing`)
  return intent
}

function corruptMembership(databasePath: string, sessionID: string) {
  const database = new Database(databasePath)
  database.run("PRAGMA foreign_keys = ON")
  const victim = database
    .query(
      `SELECT message_id
         FROM session_prompt_epoch_message
        WHERE session_id = ?
          AND prompt_epoch = (
            SELECT epoch FROM session_prompt_epoch WHERE session_id = ? AND state = 'active'
          )
        ORDER BY ordinal
        LIMIT 1`,
    )
    .get(sessionID, sessionID) as { message_id: string } | null
  if (!victim) {
    database.close()
    throw new Error(`Malformed fixture ${sessionID} has no committed membership`)
  }
  database.query("DELETE FROM message WHERE session_id = ? AND id = ?").run(sessionID, victim.message_id)
  database.close()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
