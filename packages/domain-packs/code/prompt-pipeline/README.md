# Prompt Assembly & Preparation Pipeline

## Boundary

This pack governs the deterministic preparation of a prompt before it reaches the model: templating and assembly, input scrubbing and PII redaction, explicit assumption injection, locale/i18n handling, and versioning of the prompt artifacts.

## Out of Scope

It does not own the model call, retries, or output parsing (code.llm-app), agent orchestration (code.agent), or retrieval (code.rag). It enforces but does not redefine PII rules from risk.privacy, which it always defers to and never relaxes.

## Default Posture

Prompt preparation is deterministic and auditable: the same inputs always yield the same prompt. Untrusted input is scrubbed and labeled before assembly, PII is redacted before it can reach the model, and raw input is never echoed into instruction position.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.prompt-pipeline.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
