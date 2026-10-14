/**
 * K-05/B-11 HEAD pin for the deterministic manifest (C7-10) — the single
 * machine-readable source of truth for the recorded digests. The C7-10 test, the
 * reproducibility gate (`assert-reproducible.ts`) and the docs-claims gate
 * (`script/assert-docs-claims.ts`) all read this module, so a recorded value can
 * never drift from what the gates enforce.
 *
 * The pin covers the ENTIRE generator input set (contract / migration-registry /
 * package-versions / runtime-flag-config). The generator reads the current filesystem input
 * set, including reviewed forward migrations in an uncommitted candidate.
 * Re-pin only together with an intentional input-set change: regenerate with
 * `bun run script/manifest-digest/generate-manifest.ts` and update both digests
 * here.
 *
 * This v2.0.4 pin records the reviewed working-tree candidate. Final source closure must still
 * freeze these exact inputs and compile the materialized tree; this pin is not release approval.
 */
export const HeadPin = {
  /** Source commit used to prepare the pinned tree. Informational; the digests are the gate. */
  commit: "6edd81197fe34dbb3048608055c6e2b1f645a84e",
  setTreeDigest: "38c901835a0565158ca64fcc5a334b6fd2808be06c20b0deb466d330c4aefbd0",
  overallDigest: "fea5ef8f840ae00fffa67533073c0fbf018a8d3053b32109ca14812854f19ffd",
} as const
