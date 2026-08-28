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

function readAuthority(databasePath: string, sessionID: string) {
  const database = new Database(databasePath, { readonly: true })
  const epochs = database
    .query(
      `SELECT epoch, state, authority_state, base_message_count, effective_history_hash,
              first_window_id, previous_window_id, window_id, world_state_baseline_hash
         FROM session_prompt_epoch
        WHERE session_id = ?
        ORDER BY epoch`,
    )
    .all(sessionID) as Array<{
    epoch: number
    state: string
    authority_state: string | null
    base_message_count: number | null
    effective_history_hash: string | null
    first_window_id: string | null
    previous_window_id: string | null
    window_id: string | null
    world_state_baseline_hash: string | null
  }>
  const membership = database
    .query(
      `SELECT prompt_epoch, ordinal, message_id
         FROM session_prompt_epoch_message
        WHERE session_id = ?
        ORDER BY prompt_epoch, ordinal`,
    )
    .all(sessionID) as Array<{ prompt_epoch: number; ordinal: number; message_id: string }>
  const messages = database
    .query("SELECT id FROM message WHERE session_id = ? ORDER BY time_created, id")
    .all(sessionID) as Array<{ id: string }>
  database.close()
  return { epochs, membership, messages }
}

function readLatestReceipt(databasePath: string, sessionID: string) {
  const database = new Database(databasePath, { readonly: true })
  const receipt = database
    .query(
      `SELECT request_state, prompt_epoch, prompt_window_id, effective_history_hash,
              provider_request_hash, final_request_hash, prompt_cache_key
         FROM session_tool_request_receipt
        WHERE session_id = ?
        ORDER BY request_ordinal DESC
        LIMIT 1`,
    )
    .get(sessionID) as {
    request_state: string
    prompt_epoch: number | null
    prompt_window_id: string | null
    effective_history_hash: string | null
    provider_request_hash: string | null
    final_request_hash: string | null
    prompt_cache_key: string | null
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
    "preserves compacted PromptEpoch authority across packaged fork and restart",
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

        const parentAuthority = readAuthority(databasePath, sessionID)
        const parentActive = parentAuthority.epochs.find((row) => row.state === "active")
        expect(parentActive?.epoch).toBe(1)
        expect(parentActive?.authority_state).toBe("ready")
        expect(parentActive?.world_state_baseline_hash).toMatch(/^wsb1_/)
        expect(parentAuthority.epochs.filter((row) => row.state === "active")).toHaveLength(1)
        expect(parentAuthority.membership.filter((row) => row.prompt_epoch === 1)).toHaveLength(
          parentActive?.base_message_count ?? -1,
        )
        expect(parentAuthority.membership.filter((row) => row.prompt_epoch === 0)).toHaveLength(0)

        const forked = yield* requestJson(first.url, `/session/${sessionID}/fork`, {
          method: "POST",
          headers,
          body: JSON.stringify({ intentID: "packaged-fork-smoke" }),
        })
        expect(forked.status).toBe(200)
        const childID = (forked.body as { id: string }).id
        expect(childID).toMatch(/^ses_/)
        const childAuthority = readAuthority(databasePath, childID)
        const childActive = childAuthority.epochs.find((row) => row.state === "active")
        expect(childActive?.epoch).toBe(1)
        expect(childActive?.authority_state).toBe("ready")
        expect(childActive?.effective_history_hash).toBeTruthy()
        expect(childActive?.window_id).not.toBe(parentActive?.window_id)
        expect(childAuthority.messages).toHaveLength(
          parentAuthority.membership.filter((row) => row.prompt_epoch === 1).length,
        )

        const childMessages = yield* requestJson(first.url, `/session/${childID}/message`, { headers })
        expect(childMessages.status).toBe(200)
        const childText = JSON.stringify(childMessages.body)
        expect(childText).not.toContain("retired first")
        expect(childText).not.toContain("retired second")
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
        expect(childFirstReceipt?.request_state).toBe("dispatched")
        expect(childFirstReceipt?.prompt_epoch).toBe(childActive?.epoch)
        expect(childFirstReceipt?.prompt_window_id).toBe(childActive?.window_id)
        // The receipt covers the complete effective history at dispatch, including this new user
        // message. The epoch row stores the immutable replacement-prefix hash, so those hashes are
        // intentionally different after the first child turn.
        expect(childFirstReceipt?.effective_history_hash).toMatch(/^eh1_/)
        expect(childFirstReceipt?.provider_request_hash).toHaveLength(64)
        expect(childFirstReceipt?.final_request_hash).toBe(childFirstReceipt?.provider_request_hash)
        expect(childFirstReceipt?.prompt_cache_key).toBeNull()
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
        const restartedAuthority = readAuthority(databasePath, childID)
        expect(restartedAuthority.epochs).toEqual(childAuthority.epochs)
        expect(restartedAuthority.membership).toEqual(childAuthority.membership)

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
        const childRestartHit = (yield* llm.hits).at(-1)
        expect(childRestartHit).toBeDefined()
        const childRestartMessages = providerMessages(childRestartHit?.body)
        const childRestartSerialized = JSON.stringify(childRestartMessages)
        expect(childRestartSerialized).not.toContain("retired first")
        expect(childRestartSerialized).not.toContain("retired second")
        expect(childRestartSerialized).toContain("retained current")
        const childRestartReceipt = readLatestReceipt(databasePath, childID)
        expect(childRestartReceipt?.request_state).toBe("dispatched")
        expect(childRestartReceipt?.prompt_epoch).toBe(childActive?.epoch)
        expect(childRestartReceipt?.prompt_window_id).toBe(childActive?.window_id)
        expect(childRestartReceipt?.effective_history_hash).toMatch(/^eh1_/)
        expect(childRestartReceipt?.provider_request_hash).toHaveLength(64)
        expect(childRestartReceipt?.final_request_hash).toBe(childRestartReceipt?.provider_request_hash)
        expect(childRestartReceipt?.prompt_cache_key).toBeNull()
        const totalDispatches = yield* llm.calls

        yield* Effect.promise(() =>
          writePackagedEvidence(process.env.DEEPAGENT_CODE_PACKAGE_EVIDENCE, packagedBinary, {
            parentAuthority,
            childAuthorityBeforeRestart: childAuthority,
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
