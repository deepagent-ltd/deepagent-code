import { describe, expect, test } from "bun:test"
import { Log } from "../../src/util/log"

describe("Log", () => {
  test("clone and tag never mutate or reuse a cached service logger", () => {
    const service = `log-isolation-${crypto.randomUUID()}`
    const base = Log.create({ service })
    const clone = base.clone()
    const tagged = clone.tag("session.id", "ses_private")

    expect(clone).not.toBe(base)
    expect(tagged).not.toBe(clone)
    expect(Log.create({ service })).toBe(base)
  })

  test("bounds request-derived service logger identities", () => {
    const prefix = `log-bound-${crypto.randomUUID()}`
    const first = Log.create({ service: `${prefix}-first` })
    Array.from({ length: Log.MAX_LOGGERS }, (_, index) => Log.create({ service: `${prefix}-${index}` }))

    expect(Log.create({ service: `${prefix}-first` })).not.toBe(first)
  })
})
