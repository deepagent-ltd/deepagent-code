# Network Clients, Retries & Resilience

## Boundary

This pack governs network client engineering: connection and read/write timeouts, retry policy with backoff and jitter, idempotency keys for safe retries, backpressure and flow control, connection pooling and keep-alive reuse, TLS handshake/verification, HTTP semantics, and handling partial failure.

## Out of Scope

It does not own OS-level socket/file-descriptor and process resource mechanics (code.systems) or general bug triage (code.debugging); it depends on those for FD limits and reproduction while adding network-protocol correctness and resilience reasoning.

## Default Posture

Every outbound call has bounded timeouts, retries are bounded with exponential backoff plus jitter and gated by idempotency, and clients apply backpressure rather than buffering without limit. Any change that removes a timeout, retries a non-idempotent request, or disables TLS verification requires a human gate.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.networking.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
