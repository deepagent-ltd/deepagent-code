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
 * Release preparation re-pins this value after aligning product package versions;
 * the digest gate still checks the exact committed release tree.
 */
export const HeadPin = {
  /** Source commit used to prepare the pinned tree. Informational; the digests are the gate. */
  commit: "c5ed5327",
  setTreeDigest: "e3fbb702d874f6c89f37fdcd496fb99c1b9b94433ad41634cdb6ba065e7cdbbc",
  overallDigest: "9b73a1c73cbe8033b9550aef3664911627394c9cb74ef4e5c08d65f617a17b97",
} as const
