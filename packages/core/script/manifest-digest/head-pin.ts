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
 */
export const HeadPin = {
  /** Commit whose tree the digests were pinned on. Informational; the digests are the gate. */
  commit: "0832dd0ed3a4b315c91c012bd8c519c8fdb9c99e",
  setTreeDigest: "6b89138f13b43dca0a95e5bd5fa1c3b257b8e263855fff22cb51ad317a4d2283",
  overallDigest: "89e02f613fa1d30bede86dcda35c7be838e689aba9fcc81dc916aadb1a093e5b",
} as const
