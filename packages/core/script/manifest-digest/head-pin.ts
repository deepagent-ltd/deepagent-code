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
 * V2.0.2 re-pin (2026-09-24): regenerate over the merged X-05 selection contract,
 * X-13e loaded-only capability audit contract, and X-08 im_send request identity migration.
 */
export const HeadPin = {
  /** Commit whose tree the digests were pinned on. Informational; the digests are the gate. */
  commit: "8daf3330",
  setTreeDigest: "a3c84ffd192b533dd963dd81d805665800860a4a3f2c11d4e0bec9967475122e",
  overallDigest: "d2075878d0b1ffb4961601d05772e3b8fbde70d798327de9998a028187730a50",
} as const
