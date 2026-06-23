# Production Change Risk Controls

## Boundary

This pack makes DeepAgent conservative around deployments, production-impacting code paths, external state, irreversible migrations, rollback readiness, feature flags, traffic shifting, monitoring, incident evidence, manual hotfixes, and human approval. It helps shape plans, reviews, validation, and escalation.

## Out of Scope

This pack does not execute deployments, apply production migrations, alter cloud resources, approve incidents, disable monitoring, or encourage automatic production changes. Platform-specific packs may add implementation details; this pack supplies the production-risk gate.

## Default Posture

Stop before live writes, deployment triggers, production migrations, traffic shifts, destructive state changes, or safety-gate relaxation unless an accountable human explicitly approves. Treat unknown environment, unknown owner, missing rollback, or missing observability as blockers.

## Evidence Rules

Positive documents are indexed only for max/ultra, except skills which may be listed for high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are intentionally excluded from index.json.

## Provenance

Content is domain-pack seed material derived from production-readiness, release, migration, rollback, and incident-response engineering practice; provenance_tag is domain_pack:risk.production.

## L3 Validation

Representative activation and retrieval smoke lives in `evals/smoke/l3-smoke.json`. The quality report lives in `quality/l3-report.json`. A pack reaches L3 only when activation, pack-scoped retrieval, validation smoke, diagnosis smoke, and failure dossier boundaries are all present.
