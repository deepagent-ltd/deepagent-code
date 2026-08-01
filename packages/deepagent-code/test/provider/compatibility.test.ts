import { describe, expect, test } from "bun:test"
import { applyCompatibilityProviderOptions } from "../../src/provider/compatibility"

describe("provider compatibility", () => {
  test("disables DeepSeek V4 thinking only for forced tool choices", () => {
    const options: Record<string, unknown> = {}
    applyCompatibilityProviderOptions(
      {
        providerID: "deepseek",
        id: "deepseek-v4-flash",
        api: { id: "deepseek-v4-flash", npm: "@ai-sdk/openai-compatible" },
      },
      options,
    )
    const transform = options.transformRequestBody
    if (typeof transform !== "function") throw new Error("Missing DeepSeek V4 request transformer")

    expect(transform({ model: "deepseek-v4-flash", tool_choice: "auto" })).toEqual({
      model: "deepseek-v4-flash",
      tool_choice: "auto",
    })
    expect(transform({ model: "deepseek-v4-flash", tool_choice: "required" })).toEqual({
      model: "deepseek-v4-flash",
      tool_choice: "required",
      thinking: { type: "disabled" },
    })
    expect(
      transform({ model: "deepseek-v4-flash", tool_choice: { type: "function", function: { name: "result" } } }),
    ).toEqual({
      model: "deepseek-v4-flash",
      tool_choice: { type: "function", function: { name: "result" } },
      thinking: { type: "disabled" },
    })
  })

  test("preserves an existing request transformer", () => {
    const options: Record<string, unknown> = {
      transformRequestBody: (body: Record<string, unknown>) => ({ ...body, trace: "kept" }),
    }
    applyCompatibilityProviderOptions(
      {
        providerID: "live-deepseek",
        id: "deepseek-v4-flash",
        api: { id: "deepseek-v4-flash", npm: "@ai-sdk/openai-compatible" },
      },
      options,
    )
    const transform = options.transformRequestBody
    if (typeof transform !== "function") throw new Error("Missing DeepSeek V4 request transformer")

    expect(transform({ tool_choice: "required" })).toEqual({
      tool_choice: "required",
      trace: "kept",
      thinking: { type: "disabled" },
    })
  })
})
