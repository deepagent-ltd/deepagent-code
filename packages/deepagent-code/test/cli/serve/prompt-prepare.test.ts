import { expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

function wishConfig(llmUrl: string) {
  return {
    formatter: false,
    lsp: false,
    model: "deepseek/deepseek-v4-flash",
    provider: {
      deepseek: {
        name: "DeepSeek",
        options: { baseURL: llmUrl },
        models: {
          "deepseek-v4-flash": {
            id: "deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            reasoning: true,
            provider: { npm: "@ai-sdk/openai-compatible", api: llmUrl },
            options: {},
            tool_call: true,
            limit: { context: 100_000, output: 10_000 },
          },
        },
      },
    },
  }
}

function requestJson<T>(url: string, init: RequestInit) {
  return Effect.tryPromise(async () => {
    const response = await fetch(url, init)
    const text = await response.text()
    if (!response.ok) throw new Error(`${init.method ?? "GET"} ${url} failed ${response.status}: ${text}`)
    return JSON.parse(text) as T
  })
}

cliIt.live(
  "serves wish prompt_prepare through DeepSeek auth with partial JSON output",
  ({ deepagentCode, home, llm }) =>
    Effect.gen(function* () {
      const env = {
        DEEPAGENT_CODE_CONFIG_CONTENT: JSON.stringify(wishConfig(llm.url)),
        DEEPAGENT_CODE_AUTH_CONTENT: JSON.stringify({ deepseek: { type: "api", key: "upstream-test-key" } }),
      }
      const server = yield* deepagentCode.serve({ env })
      const headers = {
        "content-type": "application/json",
        "x-deepagent-code-directory": home,
      }
      const session = yield* requestJson<{ id: string }>(`${server.url}/session`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "wish prepare cli e2e" }),
      })

      yield* llm.text(
        JSON.stringify({
          route: "code",
          refined_prompt: "请在当前仓库中定位登录测试失败原因，修复实现或测试夹具，并运行对应测试验证。",
          assumptions: [],
        }),
      )

      const prepared = yield* requestJson<{ route: string; goal: string; preview: string }>(
        `${server.url}/session/${session.id}/prompt_prepare`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            mode: "wish",
            output_language: "chinese",
            parts: [{ type: "text", text: "修复登录测试" }],
          }),
        },
      )

      expect(prepared.route).toBe("code")
      expect(prepared.goal).toContain("登录测试")
      expect(prepared.preview).toContain("登录测试")
      expect(yield* llm.calls).toBe(1)
      expect(JSON.stringify((yield* llm.hits)[0]?.body)).toContain("in Chinese")
      expect((yield* llm.hits)[0]?.headers.authorization).toBe("Bearer upstream-test-key")
    }),
  30_000,
)
