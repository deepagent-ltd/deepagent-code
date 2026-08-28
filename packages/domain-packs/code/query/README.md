# code.query

`code.query` covers deterministic, read-only information tasks: count, list, inspect, read, status, diff, log, config, and read-only SQL-style queries.

It does not cover implementation, repair, migration, deployment, or data mutation. If a request asks to write, update, delete, migrate, deploy, or otherwise mutate external state, this pack should not be the controlling pack; use the relevant code/database/platform/risk package instead.

Evidence rule: facts must come from tool, runner, git, filesystem, SQL, log, or config results. Model text is a claim until tied to a result reference. Large outputs should be summarized rather than injected whole.

User experience rule: missing evidence should degrade to `unverified`, not hard-fail the task. This package must not add extra model calls, self-consistency voting, or second-model review.

## L3 Validation

Representative activation and retrieval smoke lives in `evals/smoke/l3-smoke.json`. The quality report lives in `quality/l3-report.json`. A pack reaches L3 only when activation, pack-scoped retrieval, validation smoke, diagnosis smoke, and failure dossier boundaries are all present.
