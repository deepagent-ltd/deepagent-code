import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
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

// effect's Cause.toJSON drops the defect (an Error has no enumerable own properties), so
// `cause={"_id":"Cause","failures":[{"_tag":"Die","defect":{}}]}` was all an operator ever saw.
// Measured in an ablation container: 914 "share subscriber failed" lines in ten minutes, every one
// of them with an empty defect — the failure was visible, the reason never was.
describe("Log cause rendering", () => {
  test("an Effect Cause renders its defect message instead of serializing to an empty defect", async () => {
    const exit = await Effect.runPromiseExit(Effect.die(new Error("proxy.url must be a non-empty string")))
    if (Exit.isSuccess(exit)) throw new Error("expected a failure exit")
    const rendered = Log.formatValue(exit.cause)

    expect(rendered).toContain("proxy.url must be a non-empty string")
    expect(rendered).not.toContain('"defect":{}')
    expect(Cause.isCause(exit.cause)).toBe(true)
  })

  test("a plain object still serializes as JSON", () => {
    expect(Log.formatValue({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}')
  })
})
