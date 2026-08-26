# Changelog

This changelog contains public, user-facing product changes. Internal incident identifiers, local paths, private environment topology, test credentials, release-gate evidence, and operational measurements are intentionally excluded.

## Desktop 1.4.7 / DeepAgent Core V4.0.8

- Hardened startup recovery so incomplete continuation work settles predictably without creating retry loops.
- Improved SQLite migration compatibility and handling of transient schema-lock contention.
- Added durable activity-stage observations and bounded detection of stalled pre-dispatch work.
- Made timeline ordering deterministic when opaque identifiers wrap or arrive close together.
- Improved remote-compaction persistence and validation while preserving session isolation.
- Strengthened data-maintenance, export, and rollback safety checks.
- Aligned Desktop, Core, updater metadata, and GitHub Action version references.

## Desktop 1.4.5 / DeepAgent Core V4.0.6

- Added durable compaction lifecycle records and explicit Prompt Epoch authority.
- Rejected unknown context limits before provider dispatch.
- Added readiness-aware context assembly and durable provider request receipts.
- Hardened plan admission, versioned updates, last-known-good preservation, and UI reconciliation.
- Aligned public package, updater, and GitHub Action version references.

## Desktop 1.4.4 / DeepAgent Core V4.0.5

- Added durable claims, leases, generations, resource locks, terminal metadata, and handoffs for multi-agent work.
- Hardened task collaboration with isolated worktrees, revision-bound reviews, serialized merges, resume, and cleanup fencing.
- Connected federated context, Location-scoped indexes, Context Epoch selection, and durable session continuation.
- Consolidated private runtime storage and kept credential values in protected secret storage.
- Improved multi-agent supervision, prompt-cache retention, and evaluation coverage.

## Desktop 1.4.3 / DeepAgent Core V4.0.4

- Persisted the complete TaskRun lifecycle, exact-retry admission, ownership fencing, and result references.
- Split structured subagent execution into bounded research and finalization phases.
- Preserved typed terminal reasons for provider, schema, permission, interruption, timeout, and runtime failures.
- Improved no-progress detection using tool results, workspace state, and plan state.
- Added safer UI failure containment and cold-start validation.
- Regenerated the JavaScript SDK for durable task and delivery contracts.

## V4.0.4 - Contract-gap closure

- Changed stale-plan signals to warnings while retaining explicit step-binding protections.
- Restricted validation-result extraction to declared validation commands.
- Stabilized cancellation and retry tests against intentionally unavailable test endpoints.
- Corrected public quick-start, package, domain, security, and support documentation.

## V4.0.3 - Upstream kernel alignment

- Added the AppNode export foundation for the next session architecture.
- Added concurrency-safe DocumentStore writes with compare-and-set conflicts and recovery.
- Unified plan writes through one authoritative document path.
- Hardened read-only Git operations against hooks, filters, text conversion, and external diffs.

## V4.1 - Steering and plan editing

- Added safe mid-turn steering at provider-turn boundaries.
- Added goal-plan editing with provenance-preserving document updates.
- Improved prompt-cache reuse by removing volatile round state from the stable system prefix.
- Added bounded session-fork lineage and clearer derived-session presentation.

## V4.0 - Event-driven runtime

- Added durable events, priority routing, backpressure, claims, leases, retries, and dead-letter handling.
- Added idempotent goal ticks with durable facts and eligibility-based continuation.
- Added fail-closed security behavior and completed the first event-driven execution path.
- Added bounded long-task compression, per-model output controls, and budget updates.
- Added CLI and GUI server-surface parity and unified configuration storage.
- Added configurable OpenAI-compatible providers and model discovery.

## V3.9 - Repository, panel, and goal workflows

- Added session archive and repository-backed knowledge features.
- Added expert-panel consultation and multi-step goal execution.
- Added an AST-based symbol graph for code navigation.
- Added capability-aware plan permissions for subagents.
- Improved prompt-cache stability and adversarial workflow validation.

## V3.8 - V4 foundation

- Added session-internal scheduling and end-to-end context assembly.
- Added subagent strength levels and permission presets.
- Redesigned automatic, loop, and design modes with explicit safety controls.
- Added the initial Desktop-to-Server gateway contract.

## V3.5 - Protected credential storage

- Added operating-system-backed credential storage with a protected local fallback where native facilities are unavailable.
- Removed credential values from ordinary configuration persistence.
- Added migration of existing credentials into the protected store.
- Fixed terminal restoration, split-layout, archived-session, and stale-worktree behavior.

## V3.4.1 - Public release hardening

- Updated the project license and preserved upstream attribution.
- Consolidated the maintained public README set to English and Simplified Chinese.
- Added source-availability and security disclosures.
- Improved public package metadata, URLs, UI strings, and generated references.
- Removed obsolete built-in dependencies and aligned application translations.
