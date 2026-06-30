import { describe, expect, test } from "bun:test"
import { showFreeModelTag } from "./model-tags"

describe("showFreeModelTag", () => {
  test("only labels DeepAgent managed zero-cost models as free", () => {
    expect(showFreeModelTag({ provider: { id: "deepagent-code" }, cost: { input: 0 } })).toBe(true)
    expect(showFreeModelTag({ provider: { id: "zhipuai" }, cost: { input: 0 } })).toBe(false)
    expect(showFreeModelTag({ provider: { id: "deepagent-code" }, cost: { input: 1 } })).toBe(false)
  })
})
