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
  // Re-pinned on the K-04 branch (wip/k04-provider-ingression) after the config
  // ingression + contract edits changed digest inputs under src/config and
  // src/contract; a commit cannot contain its own hash, so the field records the
  // branch base the tree derives from.
  commit: "fa6668352fc92d4350e37e5a533eb3eb35df029c",
  setTreeDigest: "a38ebe8fe005ab4589a336c549db75747f6ed1c1b8c3e059577134529e991523",
  overallDigest: "bcfcd46eed83d2863103e96786c674bb41b6a8a441761dc111506b280b7401cc",
} as const
