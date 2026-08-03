# Goal: Import Upstream Durable Session Infrastructure

## Objective

Import the smallest durable Session V2 infrastructure boundary from the local
OpenCode upstream checkout without importing UI, product features, or legacy
application behavior.

The target is a reusable Session execution substrate for the task and Goal
control planes. This import does not switch Goal execution from the legacy
prompt loop and does not enable automatic hard-crash continuation.

## Source Baseline

- Upstream checkout: `/Users/xiuranli/code/deepagent-ai/opencode`
- Upstream implementation ref: `origin/v2`
- Inspected commit: `3f30203b72412ba7b324e86cb2ebbf6208d152ac`
- Target baseline: `dev` at `ee1d325cfb04ded09ee0b7cb3307ea9bc25eeea2`
- Target branch: `codex/merge-upstream-durable`

Git ancestry is intentionally not shared between the repositories. Code is
ported by capability and adapted to the DeepAgent package names and existing
Session admission-sequence interruption semantics.

## Existing Infrastructure To Reuse

The target already contains these upstream-derived durable primitives. They
must not be reimplemented or renamed in this import:

- caller-supplied Session IDs;
- caller-supplied prompt message IDs with exact-retry reconciliation;
- durable `session_input` admission and projection;
- synchronized per-Session event sequence;
- process-global, Session-ID-based execution routing;
- Location-scoped Session runner, model, tools, permissions, and filesystem;
- durable assistant, provider failure, tool-call, and tool-settlement events;
- stale-tool settlement without blind side-effect replay.

Upstream now calls its pending-only projection `session_pending`. DeepAgent
retains `session_input` in this import because context federation and existing
migrations reference its durable promoted records. The behavioral contract,
not the upstream table rename, is the reusable boundary.

## Import Scope

1. Add process-local Session execution observability:
   - active Session snapshot;
   - await-idle operation;
   - one durable started and terminal lifecycle observation per ownership chain.
2. Add graceful managed-process restart continuity:
   - nullable private `session.time_suspended` timestamp and partial index;
   - atomic consume of a suspension;
   - snapshot active Sessions before orderly shutdown;
   - resume each suspension at most once on the next managed start.
3. Add a production-ready Session V2 execution layer that composes the existing
   local executor instead of the compatibility no-op layer.
4. Add focused coordinator, storage, migration, execution, and restart tests.
5. Update Session V2 specifications and the schema changelog for the imported
   durable contract.

## Explicit Non-Goals

- no TUI, desktop, app, SDK, plugin, provider, catalog, browser, or tool feature;
- no wholesale replacement of the DeepAgent Session runner;
- no migration from `session_input` to upstream `session_pending`;
- no Goal or task adapter cutover from `SessionPrompt`;
- no clustered Session ownership;
- no hard-crash provider retry;
- no replay of ambiguous tool side effects;
- no exactly-once provider or tool claim.

## Safety Invariants

1. Durable admission remains separate from execution scheduling.
2. Existing admission sequence interrupt fencing remains authoritative.
3. A graceful suspension is intent to make one resume attempt, not durable live
   status and not proof that provider or tool replay is safe.
4. Interruption caused by orderly shutdown preserves suspension. Normal start,
   success, and failure clear stale suspension atomically with lifecycle
   publication.
5. A hard crash writes no suspension and never triggers automatic continuation.
6. Lifecycle events are observations. They do not become execution ownership or
   scheduler claims.

## Acceptance Criteria

- all pre-existing Session run-coordinator interruption tests still pass;
- coordinator active snapshots contain only currently owned Session chains;
- lifecycle started/terminal events are emitted once per ownership chain;
- suspension is consumed atomically by at most one resumer;
- orderly interruption preserves suspension and normal settlement clears it;
- restart scheduling starts all claimed Sessions without serially awaiting each
  complete drain;
- migration adds no inferred suspension for historical shutdown events;
- `bun typecheck` passes from `packages/core` and `packages/deepagent-code`;
- focused core tests pass from `packages/core`;
- the final diff contains no UI or unrelated feature files.

## Follow-Up Boundary

The subagent control-plane W6B/G2 work may later add Session-owned activity
fences, Physical Attempt evidence, provider dispatch classification, and tool
idempotency proofs. Until that work lands, ambiguous post-crash activity must
remain quiescent or require explicit operator resolution.
