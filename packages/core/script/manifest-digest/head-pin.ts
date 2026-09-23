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
 * C-P2-08 re-pin (2026-09-23): the migration registry gained the durable task-call
 * fan-out admission migration (20260922182048_v2_task_call_admission).
 * Post-merge re-pin (2026-09-23): the c-p2-08 branch pinned without the concurrently
 * merged k04 contract changes in its tree; regenerated over the combined merge tree.
 */
export const HeadPin = {
  /** Commit whose tree the digests were pinned on. Informational; the digests are the gate. */
  commit: "3641bc05",
  setTreeDigest: "b2fa2b37e8dd7b85943e7fe26e3d628f75752c944c8e05b1cef25facc992690a",
  overallDigest: "bfd08c292bfcae364aab53f44085e976de2e52a65c287e2b5a827d93dd92a85e",
} as const
