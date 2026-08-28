import { expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

function wishConfig(llmUrl: string) {
  return {
    formatter: false,
    lsp: false,
    model: "deepagent/deepseek-v4-flash",
    provider: {
      deepagent: {
        name: "DeepAgent",
        models: {
          "deepseek-v4-flash": {
            id: "deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            reasoning: true,
            provider: { npm: "@ai-sdk/openai-compatible", api: llmUrl },
            options: {
              authProviderID: "deepseek",
              upstreamProviderID: "deepseek",
            },
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

function requestEvents<T>(url: string, init: RequestInit) {
  return Effect.tryPromise(async () => {
    const response = await fetch(url, init)
    const text = await response.text()
    if (!response.ok) throw new Error(`${init.method ?? "GET"} ${url} failed ${response.status}: ${text}`)
    return text
      .split("\n\n")
      .flatMap((block) => block.split("\n").filter((line) => line.startsWith("data:")))
      .map((line) => JSON.parse(line.slice(5).trim()) as T)
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
          // Tier-3 wire compat: send the LEGACY "wish" literal. The server must still accept it (an
          // older client may send it) and normalize internally; a passing prepare proves acceptance.
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
      yield* llm.text(
        JSON.stringify({
          route: "code",
          refined_prompt: "请流式定位登录测试失败原因，修复实现，并运行对应测试验证。",
          assumptions: [],
        }),
      )

      const streamed = yield* requestEvents<
        | { type: "progress"; preview: string }
        | { type: "result"; result: { route: string; goal: string; preview: string } }
      >(`${server.url}/session/${session.id}/prompt_prepare_stream`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          mode: "intelligence",
          output_language: "chinese",
          parts: [{ type: "text", text: "流式修复登录测试" }],
        }),
      })

      expect(streamed.some((event) => event.type === "progress" && event.preview.includes("登录测试"))).toBe(true)
      const result = streamed.find((event) => event.type === "result")
      expect(result?.type === "result" && result.result.preview.includes("登录测试")).toBe(true)
      expect(yield* llm.calls).toBe(2)
      expect(JSON.stringify((yield* llm.hits)[0]?.body)).toContain("in Chinese")
      expect((yield* llm.hits)[0]?.headers.authorization).toBe("Bearer upstream-test-key")
    }),
  30_000,
)
