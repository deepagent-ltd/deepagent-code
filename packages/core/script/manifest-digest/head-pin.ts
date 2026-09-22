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
 */
export const HeadPin = {
  /** Commit whose tree the digests were pinned on. Informational; the digests are the gate. */
  commit: "da001699c15a583128f4a460a1e3f39145efc18c",
  setTreeDigest: "d83bf358c8c314538cecc942e9f3ad9e1a74f0f39250dcad938d22a62eed2608",
  overallDigest: "6ec128d8e4686d37ac25ee8e323eeaa5c84bc06511a6aabfa76269907a5badc4",
} as const
