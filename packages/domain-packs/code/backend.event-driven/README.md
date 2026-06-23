# Event-Driven & Messaging Systems

## Boundary

This pack governs event-driven architecture and messaging correctness: the transactional outbox, idempotent consumers, ordering and partitioning, delivery semantics, dead-lettering, replay, and schema evolution of events across producers and consumers.

## Out of Scope

It does not cover the worker runtime mechanics (code.backend.service), the underlying table storage (code.database), or metric/trace plumbing (code.observability). It assumes a broker exists and adds correctness constraints on how events are produced, consumed, and evolved.

## Default Posture

An event is published only if its source-of-truth write committed (outbox), every consumer is idempotent, and ordering guarantees are stated explicitly. Dual writes to DB and broker, consumers that assume exactly-once, or unbounded redelivery are blocking findings.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.backend.event-driven.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
