export * as ConfigCompaction from "./compaction"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"

export class Keep extends Schema.Class<Keep>("ConfigV2.Compaction.Keep")({
  tokens: NonNegativeInt.pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Compaction")({
  auto: Schema.Boolean.pipe(Schema.optional),
  prune: Schema.Boolean.pipe(Schema.optional),
  keep: Keep.pipe(Schema.optional),
  buffer: NonNegativeInt.pipe(Schema.optional),
  /**
   * Fraction of the model's input window kept as headroom BELOW the auto-compaction trigger
   * (0 < ratio ≤ 1). Defaults to 0.18, so compaction starts at ~82% of the window. `buffer`
   * (absolute tokens) takes precedence when both are set.
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
