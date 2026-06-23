# Concurrency, Races & Synchronization

## Boundary

This pack governs concurrency engineering: data races on shared mutable state, lock ordering and deadlock, async cancellation and structured lifetimes, memory ordering and atomics, idempotency under concurrent execution, and reproducing timing-dependent flaky failures deterministically.

## Out of Scope

It does not own general bug triage method (code.debugging), the test harness itself (code.testing), or single-threaded hot-path tuning (code.performance). It leans on those packs for reproduction and benchmarking while adding concurrency-specific correctness reasoning.

## Default Posture

Shared mutable state is protected by a documented synchronization discipline with a fixed lock order, and concurrent correctness is proven by a race detector and a stress/interleaving test, not by inspection. Any change that removes a lock, weakens a memory ordering, or makes a non-idempotent operation reachable concurrently requires evidence from a detector run.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.concurrency.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
