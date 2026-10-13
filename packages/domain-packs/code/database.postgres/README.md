# PostgreSQL Engineering

## Boundary

This pack governs PostgreSQL-specific engineering: MVCC and vacuum behavior, EXPLAIN ANALYZE-driven tuning, choosing index types (btree/gin/gist/brin), lock modes and CONCURRENTLY, transaction isolation levels, and JSONB modeling and indexing.

## Out of Scope

It does not cover vendor-neutral schema design (code.database), portable query authoring (code.sql), or system-level capacity planning (code.performance). It assumes those and adds Postgres-engine specifics that change correctness and performance.

## Default Posture

Schema and query changes are validated against a real plan (EXPLAIN ANALYZE) and against lock impact on a live table. Any migration that takes a strong lock on a large table, any index build without CONCURRENTLY in production, or any isolation assumption not backed by the actual level is a blocking finding.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.database.postgres.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
