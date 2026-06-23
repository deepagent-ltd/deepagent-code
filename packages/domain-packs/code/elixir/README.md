# Elixir, OTP & Phoenix

## Boundary

This pack governs Elixir engineering on the BEAM: Mix project and dependency management, OTP supervision trees and GenServers, the process/actor concurrency model, pattern matching and let-it-crash design, ExUnit testing, and Phoenix/LiveView.

## Out of Scope

It does not cover language-agnostic engineering practice (code.core) or generic service deployment/operations (code.backend.service). It adds BEAM- and OTP-specific concurrency, supervision, and Phoenix guidance and defers generic service-architecture concerns to the service pack.

## Default Posture

Concurrency is structured as supervised processes that may crash and be restarted to a known good state, not defended with sprawling try/rescue. State lives in processes addressed by message, side effects and failures are isolated per process, and the supervision tree defines the recovery contract.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.elixir.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
