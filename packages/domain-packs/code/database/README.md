# Database Engineering

## Boundary

Schema changes, migrations, transactions, constraints, indexes, query plans, locks, rollback readiness, and data loss prevention.

## Out of Scope

Business financial or medical rules, privacy retention policy, infrastructure rollout, and production operation approval are outside this pack without business, privacy, or production packs.

## Applies When

Use this pack when task evidence, repository signals, or user intent matches: database, sql, migration, transaction. It contributes refs for max/ultra context admission only; it does not bypass runtime permissions, user approval, or project-specific instructions.

## Evidence Rules

All positive seed documents use medium evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are intentionally excluded from index.json.

## Content Shape

Strategies: 8; methodologies: 6; knowledge: 10; skills: 4; failure dossiers: 8. This pack is safety-heavy: migration dry-run, expand/contract, transactions, constraints, locks, EXPLAIN plans, rollback, and data loss prevention are separate evidence surfaces.

## L3 Validation

Representative activation and retrieval smoke lives in `evals/smoke/l3-smoke.json`. The quality report lives in `quality/l3-report.json`. A pack reaches L3 only when activation, pack-scoped retrieval, validation smoke, diagnosis smoke, and failure dossier boundaries are all present.
