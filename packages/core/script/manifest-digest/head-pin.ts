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
  commit: "23f225ccff4fb76554085c94a0545bf6bda7e6f2",
  setTreeDigest: "468aacdf66cbb3da067588bb4073c6c1985977fa442b577b7086563a97e0ef2b",
  overallDigest: "457439060614b930027c3b0982073dfca3783e5fc9cda799e3bf350717bd0e64",
} as const
