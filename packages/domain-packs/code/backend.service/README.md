# Backend Service & Background Work

## Boundary

This pack governs server-side service design and background work: service boundaries, idempotent operations, retry/backoff policy, queue consumers, scheduled jobs, concurrency limits, and graceful shutdown so in-flight work is not lost or duplicated.

## Out of Scope

It does not define HTTP/RPC surface shape (code.backend.api), the messaging substrate semantics (code.backend.event-driven), metric/trace wiring (code.observability), or persistence schema (code.database). It assumes those and adds reliability constraints on top.

## Default Posture

Every operation that can be retried must be idempotent or deduplicated, every retry must back off with jitter and a cap, and every worker must drain in-flight work on shutdown. Side effects without an idempotency boundary or a dead-letter path are blocking findings.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.backend.service.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
