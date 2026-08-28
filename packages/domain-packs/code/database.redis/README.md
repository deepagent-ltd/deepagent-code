# Redis Engineering

## Boundary

This pack governs Redis engineering: cache invalidation and stampede control, TTL and eviction policy, atomic operations and Lua scripting, choosing streams versus pub/sub, distributed locks and their hazards, and RDB/AOF persistence tradeoffs.

## Out of Scope

It does not cover the system-of-record database (code.database) or the service/worker runtime that consumes Redis (code.backend.service). It assumes those and adds Redis-engine specifics for caching correctness, durability, and coordination.

## Default Posture

Cache is treated as a derived, lossy copy that may evict or expire at any moment, so reads degrade to the source and writes invalidate deterministically. Distributed locks are assumed unreliable for correctness; any lock used as the sole guard for a critical operation, any unbounded keyspace with no TTL/eviction, and any non-atomic read-modify-write are findings.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.database.redis.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
