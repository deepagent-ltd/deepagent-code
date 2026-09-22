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
  commit: "fec79f1f4f34f5c932214d4a430028d8ca92c622",
  setTreeDigest: "05ba0a0ee114b091c284dbddd9f8b7fb9a5869d24ced0a9d33d78ef159f865e2",
  overallDigest: "44942888571242ddf5d9577c0258b36ffdd77accc9dc3326e3ede9de387bfa79",
} as const
