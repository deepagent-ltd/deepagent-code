# Backend API

## Boundary

Request/response contracts, REST/GraphQL/RPC behavior, schema validation, status/error compatibility, endpoint tests, OpenAPI/schema diffs, idempotency, and client-visible observability.

## Out of Scope

Database migration mechanics, authorization policy design, security threat modeling, privacy retention, and production release gates are owned by database, security, privacy, and production packs.

## Applies When

Use this pack when task evidence, repository signals, or user intent matches: backend, api, rest, graphql. It contributes refs for max/ultra context admission only; it does not bypass runtime permissions, user approval, or project-specific instructions.

## Evidence Rules

All positive seed documents use medium evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are intentionally excluded from index.json.

## Content Shape

Strategies: 8; methodologies: 5; knowledge: 8; skills: 4; failure dossiers: 6. This pack is contract-heavy: route smoke, schema compatibility, idempotency, error shape, OpenAPI/schema diff, and client impact are separate evidence surfaces.

## L3 Validation

Representative activation and retrieval smoke lives in `evals/smoke/l3-smoke.json`. The quality report lives in `quality/l3-report.json`. A pack reaches L3 only when activation, pack-scoped retrieval, validation smoke, diagnosis smoke, and failure dossier boundaries are all present.
