import { describe, expect, test } from "bun:test"
import { WorkLeafProofCache } from "../../src/installation/work-leaf-proof-cache"

describe("terminal proof consumption cache", () => {
  test("many graphs refresh a bounded cache instead of exhausting a process lifetime gate", () => {
    const cache = new WorkLeafProofCache.Terminal<{ generation: number }>()
    for (let graph = 0; graph < 96; graph++) {
      for (let effect = 0; effect < 3; effect++)
        expect(cache.set(`work-${graph}`, `effect-${graph}-${effect}`, { generation: graph })).toBe(true)
    }
    expect(cache.workCount).toBe(64)
    expect(cache.size).toBe(192)
    expect(cache.get("effect-0-0")).toBeUndefined()
    // Authentication may refill an evicted known fact; it does not restore dispatch authority.
    expect(cache.set("work-0", "effect-0-0", { generation: 100 })).toBe(true)
    expect(cache.get("effect-0-0")).toEqual({ generation: 100 })
    expect(cache.workCount).toBe(64)
  })

  test("single Work capacity is independent and exact authenticated refresh remains usable", () => {
    const cache = new WorkLeafProofCache.Terminal<{ sealed: string }>()
    for (let effect = 0; effect < 128; effect++)
      expect(cache.set("first", `first-${effect}`, { sealed: "original" })).toBe(true)
    expect(cache.set("first", "overflow", { sealed: "overflow" })).toBe(false)
    expect(cache.set("second", "second-0", { sealed: "second" })).toBe(true)
    expect(cache.set("first", "first-0", { sealed: "rechecked" })).toBe(true)
    expect(cache.get("first-0")).toEqual({ sealed: "rechecked" })
    expect(cache.set("second", "first-0", { sealed: "foreign" })).toBe(false)
    expect(cache.get("first-0")).toEqual({ sealed: "rechecked" })
    expect(cache.size).toBe(129)
  })

  test("32 dependencies remain available through both consumers, then known settlement releases only that Work", () => {
    const cache = new WorkLeafProofCache.Terminal<{ workID: string }>()
    for (let work = 0; work < 32; work++)
      expect(cache.set(`work-${work}`, `effect-${work}`, { workID: `work-${work}` })).toBe(true)
    for (let consumer = 0; consumer < 2; consumer++) {
      for (let work = 0; work < 32; work++) expect(cache.get(`effect-${work}`)?.workID).toBe(`work-${work}`)
    }
    cache.release("work-0")
    cache.release("work-0")
    expect(cache.get("effect-0")).toBeUndefined()
    expect(cache.get("effect-1")?.workID).toBe("work-1")
    expect(cache.size).toBe(31)
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.workCount).toBe(0)
    expect(cache.get("effect-1")).toBeUndefined()
  })
})
