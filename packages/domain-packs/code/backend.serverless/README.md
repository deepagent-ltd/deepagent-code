# Serverless & Function-as-a-Service

## Boundary

This pack governs Function-as-a-Service development: stateless event-driven functions (AWS Lambda, Cloud Functions, Azure Functions), cold-start behavior, execution and payload limits, event-source triggers and fan-out, per-function IAM, and idempotent handlers. The platform owns scaling and lifecycle; you own a short-lived, stateless handler.

## Out of Scope

It does not cover long-running services or containers (code.backend.api/service), the cloud control plane itself (platform.cloud), API contract design beyond the handler, or dashboards and alerting (code.observability). It assumes a managed FaaS platform and deploy tooling already exist.

## Default Posture

Functions are ephemeral and concurrent: assume every invocation may be a cold start on fresh state, design handlers to be idempotent because at-least-once delivery causes retries, scope each function's IAM to least privilege, and never hold in-memory state across invocations as if it were durable.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.backend.serverless.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
