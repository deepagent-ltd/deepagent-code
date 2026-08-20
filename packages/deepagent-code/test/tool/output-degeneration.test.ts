/**
 * QUAL-005 (BUG-407-008 residue): deterministic coverage for OutputDegenerationError.
 *
 * The processor (session/processor.ts) throws SessionV1.OutputDegenerationError in enforce mode
 * when the reasoning N-gram degeneration detector confirms a stuck/repetitive stream, and the
 * retry policy (session/retry.ts) special-cases it as non-retryable. Before this file, the error
 * had zero dedicated tests. These tests pin:
 *   1. the error contract (type + detector verdict fields),
 *   2. the retry special-case (never retryable),
 *   3. bounded termination — the retry harness stops after the single failed attempt instead of
 *      retrying forever (contrast case proves the harness would retry a transient 5xx error).
 */
import { describe, expect } from "bun:test"
import { Effect, Exit, Schedule, Schema } from "effect"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import type { NamedError } from "@deepagent-code/core/util/error"
import { SessionRetry } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { it } from "../lib/effect"

const provider = "test"

// Deterministic degenerate-output path: the processor's detector enables above 20_000 chars and
// confirms degeneration when the repeated N-gram fraction exceeds 0.7. Reproduce the same metric
// over a highly repetitive stream so the constructed verdict is grounded in a real degenerate
// payload rather than arbitrary numbers.
const DEGENERATION_N = 4
const degeneratePayload = "degenerate-loop ".repeat(1_500) // 24_000 chars of repetitive text

function repetitionRatio(text: string) {
  const counts = new Map<string, number>()
  for (let i = 0; i <= text.length - DEGENERATION_N; i++) {
    const ngram = text.slice(i, i + DEGENERATION_N)
    counts.set(ngram, (counts.get(ngram) ?? 0) + 1)
  }
  let total = 0
  let repeated = 0
  for (const count of counts.values()) {
    total += count
    if (count > 1) repeated += count - 1
  }
  return total === 0 ? 0 : repeated / total
}

function degenerationError() {
  return new SessionV1.OutputDegenerationError({
    chars: degeneratePayload.length,
    ratio: repetitionRatio(degeneratePayload),
    detectorVersion: "1.0",
  })
}

type Err = ReturnType<NamedError["toObject"]>

const policy = (attempts: { count: number }) =>
  SessionRetry.policy({
    provider,
    parse: (error) => error as Err,
    set: () =>
      Effect.sync(() => {
        attempts.count += 1
      }),
  })

describe("tool.output-degeneration", () => {
  it.effect("degenerate payload exceeds the detector thresholds", () =>
    Effect.sync(() => {
      expect(degeneratePayload.length).toBeGreaterThan(20_000)
      expect(repetitionRatio(degeneratePayload)).toBeGreaterThan(0.7)
    }),
  )

  it.effect("carries the detector verdict with the processor's error contract", () =>
    Effect.sync(() => {
      const error = degenerationError()
      expect(SessionV1.OutputDegenerationError.isInstance(error)).toBe(true)
      expect(error.toObject().name).toBe("OutputDegenerationError")
      expect(SessionV1.OutputDegenerationError.isInstance(error.toObject())).toBe(true)
      expect(error.data.chars).toBe(degeneratePayload.length)
      expect(error.data.ratio).toBeGreaterThan(0.7)
      expect(error.data.detectorVersion).toBe("1.0")
      // Distinct error types must not be confused with the degeneration verdict.
      expect(SessionV1.ContextOverflowError.isInstance(error)).toBe(false)
      expect(SessionV1.APIError.isInstance(error)).toBe(false)
    }),
  )

  it.effect("retry special-case never treats degeneration as retryable", () =>
    Effect.sync(() => {
      const error = degenerationError()
      expect(SessionRetry.retryable(error.toObject(), provider)).toBeUndefined()
      // A transient 5xx failure stays retryable — the special case is specific, not a blanket
      // non-retry fallback.
      const retryable = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
        new SessionV1.APIError({
          message: "Internal server error",
          isRetryable: false,
          statusCode: 500,
          responseHeaders: { "retry-after-ms": "0" },
        }).toObject(),
      )
      expect(SessionRetry.retryable(retryable, provider)).toEqual({ message: "Internal server error" })
    }),
  )

  it.effect("bounded termination: the retry harness stops after the single failed attempt", () =>
    Effect.gen(function* () {
      const error = degenerationError()
      let executions = 0
      const attempts = { count: 0 }
      const failing = Effect.gen(function* () {
        executions += 1
        return yield* Effect.fail(error.toObject())
      })

      let captured: unknown = undefined
      yield* failing.pipe(
        Effect.retry(policy(attempts)),
        Effect.catch((error) =>
          Effect.sync(() => {
            captured = error
          }),
        ),
      )

      // No retry scheduled, no status published, exactly one provider attempt, original verdict.
      expect(executions).toBe(1)
      expect(attempts.count).toBe(0)
      expect(SessionV1.OutputDegenerationError.isInstance(captured)).toBe(true)
    }),
  )

  it.effect("contrast: a retryable provider error does retry under the same harness", () =>
    Effect.gen(function* () {
      const retryable = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
        new SessionV1.APIError({
          message: "Internal server error",
          isRetryable: false,
          statusCode: 500,
          responseHeaders: { "retry-after-ms": "0" },
        }).toObject(),
      )
      let executions = 0
      const attempts = { count: 0 }
      const failing = Effect.gen(function* () {
        executions += 1
        return yield* Effect.fail(retryable)
      })

      // Bounded by Schedule.recurs(2) so the contrast cannot loop forever: exactly two retries
      // (three executions). The policy's decision is consulted once more after the recurs bound
      // trips, so its `set` callback observes three decisions while only two retries execute.
      const exit = yield* failing.pipe(
        Effect.retry(policy(attempts).pipe(Schedule.both(Schedule.recurs(2)))),
        Effect.exit,
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(executions).toBe(3)
      expect(attempts.count).toBe(3)
    }),
  )

  it.effect("assistant error classification preserves the degeneration verdict untouched", () =>
    Effect.sync(() => {
      const error = degenerationError()
      const classified = MessageV2.fromError(error, { providerID: ProviderV2.ID.make(provider) })
      expect(SessionV1.OutputDegenerationError.isInstance(classified)).toBe(true)
      if (SessionV1.OutputDegenerationError.isInstance(classified)) {
        expect(classified.data.chars).toBe(error.data.chars)
        expect(classified.data.ratio).toBe(error.data.ratio)
        expect(classified.data.detectorVersion).toBe("1.0")
      }
    }),
  )
})
