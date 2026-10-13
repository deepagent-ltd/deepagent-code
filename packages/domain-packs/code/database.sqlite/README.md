# SQLite Engineering

## Boundary

This pack governs SQLite-specific engineering: WAL versus rollback journal, the single-writer concurrency model, connection pragmas (busy_timeout, synchronous, foreign_keys), type affinity quirks, full-text search with FTS5, and single-file backup and integrity.

## Out of Scope

It does not cover portable schema design (code.database) or vendor-neutral query authoring (code.sql). It assumes those and adds the embedded, single-file engine specifics that change concurrency, durability, and correctness for SQLite.

## Default Posture

An SQLite app sets pragmas explicitly per connection (WAL, busy_timeout, foreign_keys), treats writes as serialized through one writer, and backs up via the online backup API or a WAL-aware copy rather than copying a live file. Default journal with no busy_timeout, copying a live .db, or relying on declared column types are findings.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.database.sqlite.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
