import { describe, expect, test } from "bun:test"
import {
  decodeCorrelationChain,
  encodeCorrelationChain,
  correlationChainDigest,
  CorrelationDecodeError,
  type CorrelationChain,
} from "../../src/contract/correlation"

const validChain: CorrelationChain = {
  schemaVersion: "correlation-chain.v1",
  correlationId: "c-1",
  root: "input",
  links: [
    { kind: "input", id: "i-1", causedBy: undefined, hop: 0 },
    { kind: "session_admission", id: "s-1", causedBy: "i-1", hop: 1 },
    { kind: "activity", id: "a-1", causedBy: "s-1", hop: 2 },
    { kind: "selection", id: "sel-1", causedBy: "a-1", hop: 3 },
    { kind: "provider_attempt", id: "p-1", causedBy: "sel-1", hop: 4 },
  ],
  cursor: "cursor-1",
}

describe("C0-03 correlation contract", () => {
  test("round-trip encode/decode of a valid chain", () => {
    const decoded = decodeCorrelationChain(JSON.parse(encodeCorrelationChain(validChain)))
    expect(decoded.links.length).toBe(5)
    expect(decoded.cursor).toBe("cursor-1")
  })

  test("missing correlationId rejected", () => {
    const bad = { ...validChain } as Record<string, unknown>
    delete bad.correlationId
    expect(() => decodeCorrelationChain(bad)).toThrow(CorrelationDecodeError)
  })

  test("unknown link kind rejected", () => {
    const bad = { ...validChain, links: [...validChain.links, { kind: "nonsense", id: "x", hop: 5 }] }
    expect(() => decodeCorrelationChain(bad)).toThrow(CorrelationDecodeError)
  })

  test("duplicate link kind rejected (bounded once-per-kind chain)", () => {
    const bad = { ...validChain, links: [...validChain.links, { kind: "input", id: "i-2", hop: 5 }] }
    expect(() => decodeCorrelationChain(bad)).toThrow(CorrelationDecodeError)
  })

  test("non-monotonic hop rejected", () => {
    const bad = { ...validChain, links: [{ kind: "input", id: "i-1", hop: 2 }] }
    expect(() => decodeCorrelationChain(bad)).toThrow(CorrelationDecodeError)
  })

  test("negative hop rejected", () => {
    const bad = { ...validChain, links: [{ kind: "input", id: "i-1", hop: -1 }] }
    expect(() => decodeCorrelationChain(bad)).toThrow(CorrelationDecodeError)
  })

  test("extra field rejected", () => {
    const bad = { ...validChain, payload: { secret: 1 } }
    expect(() => decodeCorrelationChain(bad)).toThrow(CorrelationDecodeError)
  })

  test("digest deterministic and canonical", () => {
    const a = correlationChainDigest(validChain as never)
    const b = correlationChainDigest({ ...validChain } as never)
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})
