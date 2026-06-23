# Realtime Connections & Pub/Sub

## Boundary

This pack governs long-lived realtime connections: WebSocket/SSE connection lifecycle, reconnect and resync, backpressure, auth refresh on persistent connections, message ordering and delivery on a channel, and broadcast fan-out limits.

## Out of Scope

It does not define request/response API shape (code.backend.api), transport/TLS/load-balancer mechanics (code.networking), or browser rendering of updates (code.frontend.web). It assumes those and adds correctness and stability constraints specific to persistent connections.

## Default Posture

A realtime connection is assumed to drop and reconnect at any time, so clients resync rather than trust continuity, the server applies backpressure instead of buffering unbounded, and a connection's authorization is re-checked as tokens expire. Unbounded buffers, never-revalidated auth, and fan-out without limits are blocking findings.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.backend.realtime.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
