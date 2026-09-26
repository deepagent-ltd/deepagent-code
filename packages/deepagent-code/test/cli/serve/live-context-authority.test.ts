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

const enabled = process.env.DEEPAGENT_CODE_LIVE_CONTEXT_AUTHORITY === "1"

if (!enabled) {
  test.skip("DeepSeek context authority gate requires DEEPAGENT_CODE_LIVE_CONTEXT_AUTHORITY=1", () => {})
} else {
  cliIt.live(
    "retains V2 compacted context through fork and restart, and fences corrupt history before dispatch",
    ({ deepagentCode, home }) =>
      Effect.gen(function* () {
        const startedAt = Date.now()
        const config = yield* Effect.promise(() => loadLiveLLMConfig())
        const preflight = yield* Effect.promise(() => preflightLiveLLM(config))
        const providerID = runtimeProviderIDFor(config)
        const databaseName = "live-context-authority.db"
        const databasePath = path.join(home, ".deepagent", "code", databaseName)
        const workspace = path.join(home, "workspace")
        const marker = "context-authority-" + crypto.randomUUID()
        const forkIntentID = "live-context-authority-" + crypto.randomUUID()
        yield* Effect.promise(() => mkdir(workspace, { recursive: true }))
        expect(yield* Effect.promise(() => Bun.spawn(["git", "init", "--quiet"], { cwd: workspace }).exited)).toBe(0)

        const runtimeConfig = {
          ...liveWorkspaceConfig(config, { "*": "deny" }, { "*": "deny" }, undefined, {
            primaryPrompt: "This is a context-authority verification. Follow the current instruction exactly and do not call tools.",
            modelMaxTokens: 256,
            maxProviderTurns: 3,
          }),
          formatter: false,
          lsp: false,
          compaction: { auto: false, preserve_recent_tokens: 512, prune: false },
        }
        // The V2 Catalog reads workspace config; the env overlay serves only V1 compatibility.
        yield* Effect.promise(() => Bun.write(path.join(workspace, "deepagent-code.json"), JSON.stringify(runtimeConfig)))
        const serverOptions = {
          hostname: "127.0.0.1",
          extraArgs: ["--print-logs"],
          readyTimeoutMs: 30_000,
          env: {
            DEEPAGENT_CODE_DB: databaseName,
            DEEPAGENT_CODE_CONFIG_CONTENT: JSON.stringify(runtimeConfig),
            DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE: config.apiKeyFile,
            DEEPAGENT_CODE_DISABLE_AUTOCOMPACT: "1",
            DEEPAGENT_ENABLED: "false",
            DEEPAGENT_MODE: "general",
          },
        }
        const headers = { "content-type": "application/json", "x-deepagent-code-directory": workspace }
        const promptBody = (text: string) => JSON.stringify({
          agent: "build",
          model: { providerID, modelID: config.modelID },
          parts: [{ type: "text", text }],
        })
        const prompt = (base: string, sessionID: string, text: string) =>
          requestJson(base, "/session/" + sessionID + "/message", {
            method: "POST", headers, body: promptBody(text),
          }, config.timeoutMs * 2)

        const first = yield* deepagentCode.serve(serverOptions)
        expect((yield* requestJson(first.url, "/global/health", {}, config.timeoutMs)).status).toBe(200)
        const created = yield* requestJson(first.url, "/session", {
          method: "POST", headers, body: JSON.stringify({ title: "V2 DeepSeek context authority" }),
        }, config.timeoutMs)
        expect(created.status).toBe(200)
        const parentID = stringField(created.body, "id", "created Session")

        const establish = yield* prompt(
          first.url,
          parentID,
          "Remember the exact verification marker " + marker + " for later. For this turn reply FIRST_CONTEXT_OK only.",
        )
        expect(establish.status).toBe(200)
        expect(assistantText(establish.body)).toContain("FIRST_CONTEXT_OK")
        const secondTurn = yield* prompt(first.url, parentID, "Reply RETAINED_CONTEXT_OK only.")
        expect(secondTurn.status).toBe(200)
        expect(assistantText(secondTurn.body)).toContain("RETAINED_CONTEXT_OK")

        const compacted = yield* requestJson(first.url, "/session/" + parentID + "/summarize", {
          method: "POST",
          headers,
          body: JSON.stringify({ providerID, modelID: config.modelID, auto: false }),
        }, config.timeoutMs * 2)
        expect(compacted).toEqual({ status: 200, body: true })
        const parentAfterCompaction = readV2(databasePath, parentID)
        const manual = parentAfterCompaction.messages.find(
          (message) => message.type === "compaction" && isRecord(message.data) && message.data.reason === "manual",
        )
        if (!manual || !isRecord(manual.data) || typeof manual.data.summary !== "string") {
          throw new Error("Manual compaction did not commit a V2 summary")
        }
        expect(manual.data.summary).toContain(marker)
        expect(parentAfterCompaction.receipts.filter((receipt) => receipt.state === "settled").length).toBeGreaterThan(1)

        const parentRecovery = yield* prompt(
          first.url, parentID, "What exact verification marker did I give you? Reply with the marker only.",
        )
        expect(parentRecovery.status).toBe(200)
        expect(assistantText(parentRecovery.body)).toContain(marker)

        const forked = yield* requestJson(first.url, "/session/" + parentID + "/fork", {
          method: "POST", headers, body: JSON.stringify({ intentID: forkIntentID }),
        }, config.timeoutMs)
        expect(forked.status).toBe(200)
        const childID = stringField(forked.body, "id", "forked Session")
        const childRecovery = yield* prompt(
          first.url, childID, "What exact verification marker did the parent Session record? Reply with the marker only.",
        )
        expect(childRecovery.status).toBe(200)
        expect(assistantText(childRecovery.body)).toContain(marker)
        const childBeforeRestart = readV2(databasePath, childID)
        expect(childBeforeRestart.receipts.at(-1)).toMatchObject({
          state: "settled", provider_id: providerID, model_id: config.modelID,
        })

        const malformedFork = yield* requestJson(first.url, "/session/" + parentID + "/fork", {
          method: "POST", headers, body: JSON.stringify({ intentID: forkIntentID + "-malformed" }),
        }, config.timeoutMs)
        expect(malformedFork.status).toBe(200)
        const malformedID = stringField(malformedFork.body, "id", "malformed Session")
        const malformedBefore = readV2(databasePath, malformedID).receipts.length
        first.kill()
        yield* Effect.promise(() => first.exited)

        corruptLatestAssistant(databasePath, malformedID)
        const restarted = yield* deepagentCode.serve(serverOptions)
        expect((yield* requestJson(restarted.url, "/global/health", {}, config.timeoutMs)).status).toBe(200)
        expect(readV2(databasePath, childID)).toEqual(childBeforeRestart)

        const malformedPrompt = yield* prompt(
          restarted.url, malformedID, "This must fail before any provider dispatch.",
        )
        expect(malformedPrompt.status).toBeGreaterThanOrEqual(400)
        expect(readV2(databasePath, malformedID).receipts.length).toBe(malformedBefore)

        const restartTurn = yield* prompt(restarted.url, childID, "Reply RESTART_WINDOW_OK only.")
        expect(restartTurn.status).toBe(200)
        expect(assistantText(restartTurn.body)).toContain("RESTART_WINDOW_OK")
        const childAfterRestart = readV2(databasePath, childID)
        expect(childAfterRestart.receipts.at(-1)?.request_ordinal)
          .toBe((childBeforeRestart.receipts.at(-1)?.request_ordinal ?? 0) + 1)

        const retry = yield* requestJson(restarted.url, "/session/" + parentID + "/fork", {
          method: "POST", headers, body: JSON.stringify({ intentID: forkIntentID }),
        }, config.timeoutMs)
        expect(retry.status).toBe(200)
        expect(stringField(retry.body, "id", "retried fork")).toBe(childID)

        yield* Effect.promise(() => writeLiveArtifact(config, "context-authority-live", {
          suite: "context-authority-live",
          mode: "ext" as const,
          stack: "cli-subprocess" as const,
          status: "passed" as const,
          fingerprint: { ...modelFingerprint(config), runtimeProviderID: providerID },
          preflight: { durationMs: preflight.durationMs },
          evidence: {
            manualCompactionID: manual.id,
            parentSettledTurns: parentAfterCompaction.receipts.filter((receipt) => receipt.state === "settled").length,
            childSettledTurns: childAfterRestart.receipts.filter((receipt) => receipt.state === "settled").length,
            forkIntentID,
            exactForkRetryAdopted: true,
            restartJournalUnchanged: true,
            corruptSessionID: malformedID,
            corruptResponseStatus: malformedPrompt.status,
            corruptProviderDispatchesBefore: malformedBefore,
            corruptProviderDispatchesAfter: readV2(databasePath, malformedID).receipts.length,
            markerHash: Bun.hash(marker).toString(16),
          },
          durationMs: Date.now() - startedAt,
          completedAt: new Date().toISOString(),
        }, {
          redactions: [{ value: marker, replacement: "<context-marker>" }],
          harnessFiles: [
            "packages/deepagent-code/test/cli/serve/live-context-authority.test.ts",
            "packages/deepagent-code/script/live-llm/context-authority.ts",
            "packages/deepagent-code/script/live-llm/runtime.ts",
            "packages/llm/script/live-llm/config.ts",
          ],
          oracleVersion: "v2-compaction-fork-restart-corruption-v1",
        }))
        restarted.kill()
        yield* Effect.promise(() => restarted.exited)
      }),
    { timeout: 10 * 60_000 },
  )
}

function requestJson(base: string, requestPath: string, init: RequestInit, timeoutMs: number) {
  return Effect.promise(async () => {
    const response = await fetch(base + requestPath, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    const body: unknown = await response.json()
    return { status: response.status, body }
  })
}

function stringField(value: unknown, field: string, label: string) {
  if (!isRecord(value) || typeof value[field] !== "string") throw new Error(label + " has no " + field)
  return value[field]
}

function assistantText(value: unknown) {
  if (!isRecord(value) || !isRecord(value.info) || value.info.role !== "assistant" || !Array.isArray(value.parts)) {
    throw new Error("Provider turn did not return an assistant message")
  }
  if (!isRecord(value.info.time) || typeof value.info.time.completed !== "number") {
    throw new Error("Provider assistant turn did not settle")
  }
  return value.parts
    .flatMap((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [])
    .join("")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readV2(databasePath: string, sessionID: string) {
  const database = new Database(databasePath, { readonly: true })
  const rows = database.query(
    "SELECT id, type, seq, data FROM session_message WHERE session_id = ? ORDER BY seq",
  ).all(sessionID) as Array<{ id: string; type: string; seq: number; data: string }>
  const receipts = database.query(
    "SELECT receipt_id, request_ordinal, provider_id, model_id, state FROM session_v2_provider_turn_receipt WHERE session_id = ? ORDER BY request_ordinal",
  ).all(sessionID) as Array<{
    receipt_id: string
    request_ordinal: number
    provider_id: string
    model_id: string
    state: string
  }>
  database.close()
  return { messages: rows.map((row) => ({ ...row, data: JSON.parse(row.data) as unknown })), receipts }
}

function corruptLatestAssistant(databasePath: string, sessionID: string) {
  const database = new Database(databasePath)
  const row = database.query(
    "SELECT id FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC LIMIT 1",
  ).get(sessionID) as { id: string } | null
  if (!row) throw new Error("Malformed fork has no V2 assistant row to corrupt")
  database.query("UPDATE session_message SET data = ? WHERE session_id = ? AND id = ?")
    .run('{"content":"invalid"}', sessionID, row.id)
  database.close()
}
