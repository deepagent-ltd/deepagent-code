import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import path from "node:path"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

type JsonResponse = {
  readonly status: number
  readonly body: unknown
}

function requestJson(base: string, requestPath: string, init: RequestInit = {}): Effect.Effect<JsonResponse> {
  return Effect.promise(async () => {
    const response = await fetch(`${base}${requestPath}`, {
      ...init,
    })
    const body: unknown = await response.json()
    return { status: response.status, body }
  })
}

// RI-18 native authority readers: the compacted-history authority is the durable compaction
// request chain + V2 events + V2 provider receipts (the V1 session_prompt_epoch tables are the
// legacy projection and stay untouched by the native path).
function readCompactionAuthority(databasePath: string, sessionID: string) {
  const database = new Database(databasePath, { readonly: true })
  const requests = database
    .query(
      `SELECT request_id, status, outcome, summary_receipt_id
         FROM session_v2_compaction_request
        WHERE session_id = ?
        ORDER BY created_at`,
    )
    .all(sessionID) as Array<{
    request_id: string
    status: string
    outcome: string | null
    summary_receipt_id: string | null
  }>
  const events = database
    .query(
      `SELECT type, json_extract(data, '$.reason') AS reason
         FROM event
        WHERE aggregate_id = ? AND type LIKE '%compaction%'
        ORDER BY seq`,
    )
    .all(sessionID) as Array<{ type: string; reason: string | null }>
  database.close()
  return { requests, events }
}

function readLatestReceipt(databasePath: string, sessionID: string) {
  const database = new Database(databasePath, { readonly: true })
  const receipt = database
    .query(
      `SELECT state, user_message_id, provider_id, model_id, request_input_hash
         FROM session_v2_provider_turn_receipt
        WHERE session_id = ?
        ORDER BY request_ordinal DESC
        LIMIT 1`,
    )
    .get(sessionID) as {
    state: string
    user_message_id: string | null
    provider_id: string | null
    model_id: string | null
    request_input_hash: string | null
  } | null
  database.close()
  return receipt
}

function providerMessages(body: Record<string, unknown> | undefined) {
  const messages = body?.messages ?? body?.input
  if (!Array.isArray(messages)) throw new Error("packaged Provider request did not expose messages/input")
  return messages
}

async function writePackagedEvidence(output: string | undefined, binary: string, evidence: Record<string, unknown>) {
  if (!output) return
  const repository = path.resolve(import.meta.dir, "../../../../..")
  const manifestPath = path.resolve(path.dirname(binary), "..", "package.json")
  const manifest: unknown = await Bun.file(manifestPath).json()
  const harnessFiles = await Promise.all(
    [
      "packages/deepagent-code/test/cli/serve/packaged-fork.test.ts",
      "packages/deepagent-code/test/lib/cli-process.ts",
      "packages/deepagent-code/test/lib/llm-server.ts",
    ].map(async (file) => ({
      path: file,
      sha256: new Bun.CryptoHasher("sha256").update(await Bun.file(path.join(repository, file)).bytes()).digest("hex"),
    })),
  )
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", repository, ...args], { stdout: "pipe", stderr: "ignore" })
    return result.exitCode === 0 ? result.stdout.toString().trim() : null
  }
  await Bun.write(
    output,
    `${JSON.stringify(
      {
        schema: "deepagent-package-evidence-v1",
        oracleVersion: "bug-012-packaged-fork-v2",
        sourceCommit: git(["rev-parse", "HEAD"]),
        sourceTree: git(["rev-parse", "HEAD^{tree}"]),
        sourceDirty: (git(["status", "--porcelain", "--untracked-files=all"]) ?? "").length > 0,
        binary: {
          path: binary,
          sha256: new Bun.CryptoHasher("sha256").update(await Bun.file(binary).bytes()).digest("hex"),
          manifestPath,
          manifestSha256: new Bun.CryptoHasher("sha256").update(await Bun.file(manifestPath).bytes()).digest("hex"),
          manifest,
        },
        harnessFiles,
        harnessHash: new Bun.CryptoHasher("sha256").update(JSON.stringify(harnessFiles)).digest("hex"),
        evidence,
        completedAt: new Date().toISOString(),
      },
      undefined,
      2,
    )}\n`,
  )
}

const packagedBinary = process.env.DEEPAGENT_CODE_TEST_BINARY

if (!packagedBinary) {
  test.skip("packaged fork smoke requires DEEPAGENT_CODE_TEST_BINARY", () => {})
} else {
  cliIt.live(
    "preserves compacted history authority across packaged fork and restart (V2 native)",
    ({ deepagentCode, home, llm }) =>
      Effect.gen(function* () {
        const databaseName = "packaged-fork-smoke.db"
        const databasePath = path.join(home, ".deepagent", "code", databaseName)
        const workspace = path.join(home, "workspace")
        const serverOptions = {
          hostname: "127.0.0.1",
          env: {
            DEEPAGENT_CODE_DB: databaseName,
            DEEPAGENT_CODE_CONFIG_CONTENT: JSON.stringify({
              formatter: false,
              lsp: false,
              compaction: { tail_turns: 1, preserve_recent_tokens: 1000, prune: false },
              provider: {
                test: {
                  name: "Test",
                  id: "test",
                  env: [],
                  npm: "@ai-sdk/openai-compatible",
                  models: {
                    "test-model": {
                      id: "test-model",
                      name: "Test Model",
                      attachment: false,
                      reasoning: false,
                      temperature: false,
                      tool_call: true,
                      release_date: "2025-01-01",
                      limit: { context: 100_000, output: 10_000 },
                      cost: { input: 0, output: 0 },
                      options: {},
                    },
                  },
                  options: { apiKey: "packaged-fork-smoke", baseURL: llm.url },
                },
              },
            }),
          },
        }
        const init = yield* Effect.promise(() => Bun.spawn(["git", "init", "--quiet", workspace]).exited)
        expect(init).toBe(0)
        const headers = {
          "content-type": "application/json",
          "x-deepagent-code-directory": workspace,
        }

        const first = yield* deepagentCode.serve(serverOptions)
        const health = yield* requestJson(first.url, "/global/health")
        expect(health.status).toBe(200)

        const created = yield* requestJson(first.url, "/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "packaged authority" }),
        })
        expect(created.status).toBe(200)
        const sessionID = (created.body as { id: string }).id
        expect(sessionID).toMatch(/^ses_/)

        for (const text of ["retired first", "retired second", "retained current"]) {
          const prompt = yield* requestJson(first.url, `/session/${sessionID}/message`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              parts: [{ type: "text", text }],
            }),
          })
          expect(prompt.status).toBe(200)
        }

        const summarized = yield* requestJson(first.url, `/session/${sessionID}/summarize`, {
          method: "POST",
          headers,
          body: JSON.stringify({ providerID: "test", modelID: "test-model", auto: false }),
        })
        expect(summarized.status).toBe(200)
        expect(summarized.body).toBe(true)

        const parentAuthority = readCompactionAuthority(databasePath, sessionID)
        expect(parentAuthority.requests).toHaveLength(1)
        expect(parentAuthority.requests[0]).toMatchObject({ status: "settled", outcome: "compacted" })
        expect(parentAuthority.requests[0]?.summary_receipt_id).toBeTruthy()
        expect(parentAuthority.events.map((row) => `${row.type}:${row.reason}`)).toEqual([
          "session.next.compaction.started.1:manual",
          "session.next.compaction.ended.2:manual",
        ])

        const forked = yield* requestJson(first.url, `/session/${sessionID}/fork`, {
          method: "POST",
          headers,
          body: JSON.stringify({ intentID: "packaged-fork-smoke" }),
        })
        expect(forked.status).toBe(200)
        const childID = (forked.body as { id: string }).id
        expect(childID).toMatch(/^ses_/)
        // Native compaction keeps the full transcript VISIBLE (the UI history is never rewritten);
        // the compaction boundary binds the MODEL context, proven below by the provider request.
        const childMessages = yield* requestJson(first.url, `/session/${childID}/message`, { headers })
        expect(childMessages.status).toBe(200)
        const childText = JSON.stringify(childMessages.body)
        expect(childText).toContain("retired first")
        expect(childText).toContain("retired second")
        expect(childText).toContain("retained current")

        const childCallsBeforeFirstTurn = yield* llm.calls
        const childFirstTurn = yield* requestJson(first.url, `/session/${childID}/message`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "packaged child first provider turn" }],
          }),
        })
        expect(childFirstTurn.status).toBe(200)
        yield* llm.wait(childCallsBeforeFirstTurn + 1)
        const childFirstHit = (yield* llm.hits).at(-1)
        expect(childFirstHit).toBeDefined()
        const childFirstMessages = providerMessages(childFirstHit?.body)
        const childFirstSerialized = JSON.stringify(childFirstMessages)
        expect(childFirstSerialized).not.toContain("retired first")
        expect(childFirstSerialized).not.toContain("retired second")
        expect(childFirstSerialized).toContain("retained current")
        const childFirstReceipt = readLatestReceipt(databasePath, childID)
        // The V2 receipt binds the settled child turn to its durable identity and request bytes.
        expect(childFirstReceipt?.state).toBe("settled")
        expect(childFirstReceipt?.user_message_id).toBeTruthy()
        expect(childFirstReceipt).toMatchObject({ provider_id: "test", model_id: "test-model" })
        expect(childFirstReceipt?.request_input_hash).toHaveLength(64)
        const childAfterFirstTurn = yield* requestJson(first.url, `/session/${childID}/message`, { headers })
        expect(childAfterFirstTurn.status).toBe(200)
        const childTextAfterFirstTurn = JSON.stringify(childAfterFirstTurn.body)

        first.kill()
        expect(yield* Effect.promise(() => first.exited)).toEqual(expect.any(Number))

        const second = yield* deepagentCode.serve(serverOptions)
        const restartedHealth = yield* requestJson(second.url, "/global/health")
        expect(restartedHealth.status).toBe(200)
        const restartedMessages = yield* requestJson(second.url, `/session/${childID}/message`, { headers })
        expect(restartedMessages.status).toBe(200)
        expect(JSON.stringify(restartedMessages.body)).toBe(childTextAfterFirstTurn)
        // The compacted-history authority survives restart: the child's durable compaction state
        // and settled receipts are unchanged after the process comes back.
        const restartedAuthority = readCompactionAuthority(databasePath, childID)
        expect(restartedAuthority.requests).toHaveLength(0)

        const childCallsBeforeRestartTurn = yield* llm.calls
        const childRestartTurn = yield* requestJson(second.url, `/session/${childID}/message`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "packaged child restart provider turn" }],
          }),
        })
        expect(childRestartTurn.status).toBe(200)
        yield* llm.wait(childCallsBeforeRestartTurn + 1)
        // The settled child turn can trigger a durable-learning reviewer dispatch (its own
        // provider call) after the continuation lands — pick the continuation hit by its user
        // marker instead of position.
        const childRestartHit = (yield* llm.hits).findLast((hit) =>
          JSON.stringify(providerMessages(hit?.body)).includes("packaged child restart provider turn"),
        )
        expect(childRestartHit).toBeDefined()
        const childRestartMessages = providerMessages(childRestartHit?.body)
        const childRestartSerialized = JSON.stringify(childRestartMessages)
        expect(childRestartSerialized).not.toContain("retired first")
        expect(childRestartSerialized).not.toContain("retired second")
        expect(childRestartSerialized).toContain("retained current")
        const childRestartReceipt = readLatestReceipt(databasePath, childID)
        expect(childRestartReceipt?.state).toBe("settled")
        expect(childRestartReceipt?.user_message_id).toBeTruthy()
        expect(childRestartReceipt).toMatchObject({ provider_id: "test", model_id: "test-model" })
        expect(childRestartReceipt?.state).toBe("settled")
        expect(childRestartReceipt?.request_input_hash).toHaveLength(64)
        const totalDispatches = yield* llm.calls

        yield* Effect.promise(() =>
          writePackagedEvidence(process.env.DEEPAGENT_CODE_PACKAGE_EVIDENCE, packagedBinary, {
            parentAuthority,
            childAuthorityAfterRestart: restartedAuthority,
            requestReceipts: {
              childFirstTurn: childFirstReceipt,
              childRestartTurn: childRestartReceipt,
            },
            providerRequests: {
              childFirstTurnSha256: new Bun.CryptoHasher("sha256")
                .update(JSON.stringify(childFirstMessages))
                .digest("hex"),
              childRestartTurnSha256: new Bun.CryptoHasher("sha256")
                .update(JSON.stringify(childRestartMessages))
                .digest("hex"),
              retiredSentinelsAbsent: true,
              retainedSentinelPresent: true,
            },
            dispatchCounts: {
              childFirstTurn: childCallsBeforeFirstTurn + 1,
              childRestartTurn: childCallsBeforeRestartTurn + 1,
              total: totalDispatches,
            },
          }),
        )

        const retry = yield* requestJson(second.url, `/session/${sessionID}/fork`, {
          method: "POST",
          headers,
          body: JSON.stringify({ intentID: "packaged-fork-smoke" }),
        })
        expect(retry.status).toBe(200)
        expect((retry.body as { id: string }).id).toBe(childID)
        second.kill()
        expect(yield* Effect.promise(() => second.exited)).toEqual(expect.any(Number))
      }),
    { timeout: 120_000 },
  )
}
