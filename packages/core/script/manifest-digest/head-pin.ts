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
 * This v2.0.5 pin records the reviewed working-tree candidate. Final source closure must still
 * freeze these exact inputs and compile the materialized tree; this pin is not release approval.
 */
export const HeadPin = {
  /** Source commit used to prepare the pinned tree. Informational; the digests are the gate. */
  commit: "6fb36db2",
  setTreeDigest: "8955602ba44ebfe4816abd08c1aff32325f63d089159cd9aae6cfb91ef5b0ca2",
  overallDigest: "5bb71c4f041357eb66ddc685fdbebe4dbc73cfcb3a1c6203c28b5a519db3ed66",
} as const
