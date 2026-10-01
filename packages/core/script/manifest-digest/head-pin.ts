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
  commit: "e18f3e91",
  setTreeDigest: "280e5fc8fcbc01b87b461cd2ccfe94fe8eb3c35fc552e0aa55c2c0488e67c4e3",
  overallDigest: "c4d1b7b729d1bc804e9319557b660ee295dfd04eb96ff268ca54fd4373b5096a",
} as const
