# Changelog

This changelog contains public, user-facing product changes. Internal incident identifiers, local paths, private environment topology, test credentials, release-gate evidence, and operational measurements are intentionally excluded.

## Core 2.0.2 / Desktop 2.0.2

Release labels: `core-v2.0.2` and `desktop-v2.0.2` (`2.0.2`).

### Sessions and history

- Legacy sessions no longer accept writes through the old surfaces: editing or deleting historical message parts returns typed guidance to adopt the session instead of silently writing the legacy projection, and sharing actions validate session state first, with conflicts surfaced honestly in the UI.
- Manual compaction is honest about outcomes: over-budget summaries are refused with an explicit result instead of being reported as compacted, and a completed run keeps a verifiable receipt.
- Stalled-session challenges survive restarts and resume durably; an expired permission owner rotates instead of deadlocking the session.
- A delegated task's merged PR can be undone through an audited rollback that reverts the review and merge records together with the workspace.

### Sharing

- Public web sharing is off by default in this release; it will return in a later version.
- Local session ZIP export/import remains available and now scrubs credential material — cookies, basic-auth headers, and encoded or serialized secret forms — from exported data.

### Server mode

- Added a tenant-gated transparent LLM proxy for server deployments: provider traffic flows through per-tenant lanes bound to tool policy, with durable audit events, admission-serialized token accounting, and per-provider-turn usage records.
- The gateway binds its service inventory to the running composition, so config drift cannot serve stale tool surfaces.

### Agents and integrations

- Agent pushes deliver to bound Slack channels: bindings are fail-closed (empty, incomplete, or revoked bindings never send), pushes respect rate limits and quiet hours, and retries never double-send.
- `@agent` and `@reference` mentions in prompts render into provider requests through the durable wire path.
- Configured instruction files load into the system context.

### Providers

- Kimi connects again after upstream catalog renames: official provider ids are bridged to their renamed catalog entries end to end.
- Mixed-generation config files (V1 `provider` keys alongside the V2 `providers` catalog) no longer break config loading.

### Desktop fixes

- An unreachable server now shows a real offline state — naming the server, re-probing automatically, and offering one-click switching to another configured server — instead of a mislabeled maintenance banner over an indefinitely loading app; a server that drops mid-session keeps already-loaded content behind a reconnecting banner and recovers automatically when it returns.
- Intelligence draft preparation that fails on the server degrades visibly: the message is sent directly with a clear notice instead of silently locking the composer.
- The settings dialog always offers a close button, and Escape reliably closes and reopens dialogs.
- New V2 chats resolve the model before the first question, live replies render in directory sessions, and chat lists refresh from the directory journal.
- Tool artifacts use Node file APIs in the packaged desktop app; packaged builds are located on both macOS architectures; plugin settings read from the server context; provider-recovery lists retry transient failures instead of erroring the whole app.

## Core 2.0.1 / Desktop 2.0.1

Release labels: `core-v2.0.1` and `desktop-v2.0.1` (`2.0.1`).

### Windows native support

- Native Windows is now a first-class platform: data, caches and worktrees live under `%LOCALAPPDATA%`, config and credentials roam under `%APPDATA%`, and a one-time migration moves the legacy unified home on first start.
- Shell validation understands PowerShell semantics: commands run through a pwsh → powershell → cmd resolution chain, POSIX scripts resolve through Git Bash when present, and unrepresentable commands fail with typed guidance instead of a blanket platform refusal.
- The Windows desktop installer is a guided NSIS setup that adds the app to the user PATH (no system changes), and the desktop imports user/system environment variables from the registry at startup. The WSL requirement is removed across app, docs and packaging.
- Secrets on Windows are stored through DPAPI-backed encryption instead of plaintext fallbacks.

### Session migration and backup tooling

- Full-transcript Markdown export for every session, with a resumable batch exporter and a per-run content manifest.
- A guided V1→V2 migration flow: staged phases with progress in the maintenance shell, verified backups, a post-migration compliance report, backup retention governance, and an explicitly confirmed disk-reclaim step that never touches incident copies.

### Providers and models

- Custom config-defined providers now run on the V2 runtime end to end; undeclared pricing and limits surface as honestly unavailable instead of zero.
- Fixed custom providers being unresolvable in V2 sessions (origin-tracked catalog entries).

### Subagents and recovery

- Subagent permission inheritance keeps a restrictive parent from silently stripping child agents of every tool.
- Task fan-out accounting survives restarts; worktrees left by timed-out runs are reclaimed after a grace period while recovery-required runs are never touched.
- Provider recovery exposes one command surface across legacy and V2 receipts, including an evidence-bound confirm-settled exit; sessions blocked from redrive surface with explicit reasons.

### Fixes

- Tool result metadata (exit codes, truncation markers, output paths) is visible again on projected sessions.
- Bash results always end with a canonical `exit code: N` trailer; registry environment expansion cannot crash startup on circular values.
- Structured-output evidence from subagents is bound to the answer message as designed.
- Updated dependencies covering 14 published advisories (including a critical template RCE).
- `deepagent export --format md` writes a titled Markdown transcript next to the session.

## Core 2.0 / Desktop 2.0

Release labels: `core-v2.0` and `desktop-v2.0` (`2.0.0`).

- Consolidated the durable V2 session runtime as the beta release line for Core and Desktop: sessions survive restarts, interruption and startup recovery settle predictably, and provider ownership, activity projection and migration compatibility are hardened.
- Added the official DeepAgent platform provider (OpenAI Chat Completions + Responses, Anthropic-compatible) with live calibration; GPT/DeepSeek families run on the Responses protocol.
- Added the capability system: a machine-readable manifest catalog, L0 boot catalog and `capability_search` discovery entry in the production context, with durable load receipts and a per-session catalog/load snapshot bound into the prepared attempt identity.
- Connected the four-graph context base into the V2 runner with explicit per-graph readiness status (never a silent fallback), staged V2 adapters, and deterministic selection rows.
- Added byte-stable history projection: uniform tool-output caps, protocol-aware reasoning replay, and budget-triggered batched clearing — measured 96%+ prefix-cache hit rate.
- Measured on DeepSWE tasks against the mini-swe-agent baseline (same model): output tokens cut to roughly one third, fix-to-pass rate up from 71.8% to 98.4% on harder tasks.
- Added durable task delegation: isolated git worktrees for write-capable subagents, per-SHA PR review, generation-fenced recovery.
- Removed 7,269-line prompt.ts V1 monolith; replaced with lean V2 surfaces.
- Added download distribution with mirror priority, sha256 verification, and GitHub Releases fallback.

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
