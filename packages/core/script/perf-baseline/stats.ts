export * as PerfStats from "./stats"

// Statistical discipline for C0-06 (wave-manifest-w0-c0.md §2 Lane B):
// p50/p95/p99 are computed from the raw sample array by sorting and linear
// interpolation. No outlier detection, trimming, or silent dropping happens
// anywhere in this module — every collected sample flows into the summaries.

export interface Summary {
  readonly n: number
  readonly min: number
  readonly max: number
  readonly mean: number
  /** Population standard deviation (divisor n). */
  readonly stdev: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
}

export class EmptySamplesError extends Error {
  constructor() {
    super("cannot summarize an empty sample set")
  }
}

const finite = (value: number) => Number.isFinite(value)

export const validateSamples = (samples: readonly number[]): readonly number[] => {
  if (!samples.every(finite)) throw new TypeError("samples must be finite numbers")
  return samples
}

/** Linear-interpolation percentile on sorted samples. q in [0,100]. */
export const percentile = (samples: readonly number[], q: number): number => {
  validateSamples(samples)
  if (samples.length === 0) throw new EmptySamplesError()
  if (!(q >= 0 && q <= 100)) throw new RangeError(`percentile out of range: ${q}`)
  const sorted = samples.toSorted((a, b) => a - b)
  const rank = (q / 100) * (sorted.length - 1)
  const lower = Math.floor(rank)
  const fraction = rank - lower
  return lower === sorted.length - 1 ? sorted[lower]! : sorted[lower]! + fraction * (sorted[lower + 1]! - sorted[lower]!)
}

export const summarize = (samples: readonly number[]): Summary => {
  validateSamples(samples)
  if (samples.length === 0) throw new EmptySamplesError()
  const n = samples.length
  const mean = samples.reduce((total, sample) => total + sample, 0) / n
  const variance = samples.reduce((total, sample) => total + (sample - mean) ** 2, 0) / n
  return {
    n,
    min: Math.min(...samples),
    max: Math.max(...samples),
    mean,
    stdev: Math.sqrt(variance),
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
  }
}

/**
 * Heavy-tail guard rail for wall-clock-heavy scenarios (cold start): when p99 is many times
 * p50, one extra sweep is appended as a SEPARATE series so both passes stay visible. This
 * verdict only schedules reruns — it is never used to drop or trim collected samples.
 */
export const DISPERSION_RERUN_RATIO = 3

export interface DispersionVerdict {
  readonly ratio_p99_over_p50: number
  readonly rerun_required: boolean
}

export const dispersionVerdict = (samples: readonly number[]): DispersionVerdict => {
  const summary = summarize(samples)
  const ratio = summary.p99 / summary.p50
  return {
    ratio_p99_over_p50: Number.isFinite(ratio) ? ratio : 0,
    rerun_required: summary.p50 > 0 && ratio >= DISPERSION_RERUN_RATIO,
  }
}

/** Least-squares slope of y over its integer index (x = 0..n-1). Used for RSS growth rate. */
export const slopePerStep = (series: readonly number[]): number => {
  validateSamples(series)
  const n = series.length
  if (n < 2) throw new EmptySamplesError()
  const xMean = (n - 1) / 2
  const yMean = series.reduce((total, sample) => total + sample, 0) / n
  let numerator = 0
  let denominator = 0
  for (let index = 0; index < n; index++) {
    numerator += (index - xMean) * (series[index]! - yMean)
    denominator += (index - xMean) ** 2
  }
  return numerator / denominator
}

export const STAT_METHOD = "p50/p95/p99 = linear interpolation over all raw samples, inclusive rank q/100*(n-1); no trimming"

export const round = (value: number, digits = 3) => Number(value.toFixed(digits))
