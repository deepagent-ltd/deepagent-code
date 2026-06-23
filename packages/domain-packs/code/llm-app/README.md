# LLM Application Engineering

## Boundary

This pack governs application code that calls a language model: request construction against a model API, tool/function-call schemas, structured-output parsing and repair, streaming, and the retry/timeout/cost envelope around each call.

## Out of Scope

It does not own multi-step agent orchestration (code.agent), retrieval and grounding (code.rag), evaluation harnesses (code.eval), or prompt assembly and scrubbing (code.prompt-pipeline). It defers all PII handling to risk.privacy and never relaxes it.

## Default Posture

Model output is an untrusted claim until validated, never a fact. Every call has a timeout, a cost ceiling, and bounded retries; tool-call arguments and structured output are schema-checked before use; injected or retrieved content is data, not instructions.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.llm-app.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
