export * as ConfigCompaction from "./compaction"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"

export const Mode = Schema.Literals(["adaptive", "long", "extreme"])
export type Mode = typeof Mode.Type

export const SummaryTokens: Record<Mode, number> = { adaptive: 20_000, long: 32_000, extreme: 48_000 }

export class Keep extends Schema.Class<Keep>("ConfigV2.Compaction.Keep")({
  tokens: NonNegativeInt.pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Compaction")({
  auto: Schema.Boolean.pipe(Schema.optional),
  mode: Mode.pipe(Schema.optional),
  prune: Schema.Boolean.pipe(Schema.optional),
  keep: Keep.pipe(Schema.optional),
  buffer: NonNegativeInt.pipe(Schema.optional),
  /**
   * Explicit legacy proportional headroom (0 < ratio ≤ 1). Three-mode defaults use bounded
   * advance headroom rather than subtracting 18% from their work lines. `buffer` (absolute
   * tokens) takes precedence when both are explicitly configured.
   */
  buffer_ratio: Schema.Number.pipe(
    Schema.check(Schema.isGreaterThan(0)),
    Schema.check(Schema.isLessThanOrEqualTo(1)),
    Schema.optional,
  ),
  /** Fraction of the window retained verbatim after a compaction (0 < ratio ≤ 1); overrides
   * `keep.tokens` when set. */
  keep_ratio: Schema.Number.pipe(
    Schema.check(Schema.isGreaterThan(0)),
    Schema.check(Schema.isLessThanOrEqualTo(1)),
    Schema.optional,
  ),
}) {}
