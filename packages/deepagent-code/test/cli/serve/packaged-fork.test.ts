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

        first.kill()
        expect(yield* Effect.promise(() => first.exited)).toEqual(expect.any(Number))

        const second = yield* deepagentCode.serve(serverOptions)
        const restartedHealth = yield* requestJson(second.url, "/global/health")
        expect(restartedHealth.status).toBe(200)
        const restartedMessages = yield* requestJson(second.url, `/session/${childID}/message`, { headers })
        expect(restartedMessages.status).toBe(200)
        expect(JSON.stringify(restartedMessages.body)).toBe(childText)
        const restartedAuthority = readAuthority(databasePath, childID)
        expect(restartedAuthority.epochs).toEqual(childAuthority.epochs)
        expect(restartedAuthority.membership).toEqual(childAuthority.membership)

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
