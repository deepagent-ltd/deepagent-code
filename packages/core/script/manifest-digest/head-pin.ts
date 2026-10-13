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
 * This v2.0.3 pin records the reviewed working-tree candidate. Final source closure must still
 * freeze these exact inputs and compile the materialized tree; this pin is not release approval.
 */
export const HeadPin = {
  /** Source commit used to prepare the pinned tree. Informational; the digests are the gate. */
  commit: "f56ce53670035fad173e6a27a5e8edcaddf5d018",
  setTreeDigest: "34cafa0ba99527256561f3045817277faeba3e4aa2daf7bf82729991b7021d22",
  overallDigest: "7161bca967cf9dad7c3d82afcae94a97424c21dcb5925093c88a5d2d9d9e4ae9",
} as const
