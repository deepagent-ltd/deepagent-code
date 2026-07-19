# Changelog

## V4.0.4 - Contract-gap closure (engine-decoupled)

- Fix Plan Gate deadlock: stale-plan latch now warns (never hard-blocks) on tool execution, aligned with codex exec-policy philosophy. A mutating tool on a stale plan receives a reminder but always runs.
- Fix goal-loop scorer false positives: `extractValidationResults` now scopes extraction to declared validation commands only (toolCallId→command mapping), with latest-wins per command. Diagnostic bash calls no longer poison the score.
- Fix cancel/loop test flake: `maxRetries:0` in the test provider config prevents AI SDK exponential-backoff retries against the intentionally-dead test URL; per-test budgets raised from 3 s to 15 s.
- Bump desktop app to 1.4.2.
- Publishing truth: fix quick-start command (`deepagent-code run`), comment out unpublished npm install, unify domain to `deepagent.ltd`, replace `lessweb`/`anomalyco` org handles, update SECURITY.md supported-version line and M-CRED status, update CHANGELOG.

## V4.0.3 - Upstream kernel alignment (AppNode foundation)

- AppNode foundation: additive node export layer aligning with upstream opencode V2 session architecture.
- DocumentStore concurrency-safe durable body (F30-1): atomic CAS writes, version conflicts, recovery.
- Plan single source of truth (I33-1): goal path and tool path write one plan document; DocumentStore is the authority.
- safeGit hardening (I33-5): `--no-ext-diff --no-textconv` added to all read-path git calls; hook execution disabled via `core.hooksPath=/dev/null`; clean/smudge/process filters never invoked on read-only paths.

## V4.1 - Steering + plan hot-edit

- Steering foundation (S1.1): absorb mid-turn user input at the next turn boundary without aborting the current turn.
- Goal plan hot-edit (S1.2): update plan steps while a goal loop is running; orphan-doc bug fixed (upsert-by-description → updateWithProvenance by-id).
- Cache regression fix: DeepAgent gateway no longer bakes per-round volatile state (round number, budget, previous results) into the system prefix, preserving prompt cache across intra-turn calls.
- Subagent panel and session fork lineage: forks use `metadata.forkedFrom`; depth cap 3; derived-from banner and folder-tree nesting.

## V4.0 - Event-driven paradigm

- Event-driven Agent OS: durable events, priority routing, backpressure, worker claims, leases, handoffs, retries, dead-letter recovery.
- Consumer-driven goals: `goal.tick.requested` claims and executes one idempotent tick, records facts, schedules next tick when goal remains eligible.
- V4.0-beta closeout: producer-starvation fix, security fails-closed, half-wired consumers wired. Autonomous path live in production.
- V4.0.1 long-task design: soft-landing compression (P0), World State responsibility separation (P1), budget hot-swap without restart (P2), idempotent + per-model output (P3). Four feature flags. Fully verified.
- Plan gate P0+P1: plan-stale signals all degrade to warn; U9 per-step binding retains hard block with grace release.
- CLI ↔ GUI parity: full legacy server surface mounted on new CLI daemon; sessionClient wrapper seam.
- Config data-root unification: global config moved from `~/.config/deepagent-code` to `~/.deepagent/code/config.jsonc` (claude/codex style).
- Zero-config provider: add third-party provider with URL + key; protocol auto-detect; model discovery from `/models`.

## V3.9 - Repo/Wiki + Expert Panel + Goal Loop

- Repo and Wiki integration: session archive, wiki-backed knowledge, cross-session search.
- Expert Panel: chat-button convenes a panel of domain experts; `panel.consult` tool.
- Goal Loop: `goal_driver.ts` drives multi-step autonomous goals; goal-tick event pipeline.
- AST code-graph: tree-sitter based symbol graph for semantic navigation.
- Subagent plan permissions: plan-write capability gating per subagent.
- Adversarial review wave: 20-file fix commit; flag-gating, budget-ceiling, anonymization, leaf-calls, sealed-leak all fixed; Arbiter + security boundary verified.
- Cache hit regression root cause: volatile per-round state in system prefix → fixed by moving it out of the cached prefix.

## V3.8 - V4.0 pre-release foundation

- Session-internal scheduler: all sub-agent execution driven via `SessionPrompt.Service`; no-op stack replaced.
- Context wiring: full context assembly pipeline connected end-to-end.
- Sub-agent strength levels: permission presets per agent mode.
- Mode redesign: codex-aligned auto/loop/design modes; flag kill-switch; permission presets.
- Server mode connection: desktop→Server Edition gateway; wire contract; client code map.

## V3.5 - M-CRED secure secret storage

- Secrets stored in OS-backed secret storage: macOS Keychain (production), Linux Secret Service and Windows Credential Manager stubs with 0600-file fallback.
- MCP credential values no longer persist in plain-text configuration; only variable names or references travel through config.
- Credential migration: existing stored secrets migrated to the new store on first launch.
- PTY and terminal fixes: stale-worktree redirect, terminal split circular-tree bug.
- Archived sessions: restore, unarchive, delete operations.
- Stale worktree redirect: same-repo clones share one project row; `fromDirectory` now returns live clone dir.

## V3.4.1 - Public release hardening

- Switch project license to AGPL-3.0-or-later.
- Preserve upstream MIT attribution in NOTICE.
- Consolidate official README maintenance to English and Simplified Chinese.
- Add source-availability and security disclosures for AGPL network use.
- Document V3.4.1 MCP credential-storage limitation and V3.5 M-CRED direction.
- Add full-history secret-scan baseline with reviewed gitleaks findings.
- Rebrand package metadata, URLs, UI strings, WSL paths, and generated references from upstream naming to DeepAgent Code naming.
- Remove upstream-named built-in plugin dependencies from the default plugin set.
- Align English and Simplified Chinese app i18n keys.
