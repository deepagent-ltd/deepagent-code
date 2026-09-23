/**
 * K-05/B-11 HEAD pin for the deterministic manifest (C7-10) — the single
 * machine-readable source of truth for the recorded digests. The C7-10 test, the
 * reproducibility gate (`assert-reproducible.ts`) and the docs-claims gate
 * (`script/assert-docs-claims.ts`) all read this module, so a recorded value can
 * never drift from what the gates enforce.
 *
 * The pin covers the ENTIRE generator input set (contract / migration-registry /
 * package-versions / runtime-flag-config — committed, git-tracked files only).
 * Re-pin only together with an intentional input-set change: regenerate with
 * `bun run script/manifest-digest/generate-manifest.ts` and update both digests
 * here.
 *
 * V2.0.2 re-pin (2026-09-24): regenerate over the merged X-05 selection contract
 * and X-13e loaded-only capability audit contract.
 */
export const HeadPin = {
  /** Commit whose tree the digests were pinned on. Informational; the digests are the gate. */
  commit: "8daf3330",
  setTreeDigest: "8ab8cb189a2750b69c4cc73c9e272199a3b48eddf1ce9ed1b1697fcc44e0436f",
  overallDigest: "9d8d6e8d024c089c3044628c8a73e47ff51773641e7482c2a83b71e251e73ed0",
} as const
