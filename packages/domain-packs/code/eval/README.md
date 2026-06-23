# LLM Evaluation & Regression Harnesses

## Boundary

This pack governs evaluation of model-based systems: golden datasets, regression suites, metric selection, LLM-as-judge scoring and its limits, leakage prevention, statistical significance, and ablation design that isolates what actually changed quality.

## Out of Scope

It does not own unit/integration test infrastructure broadly (code.testing) which it builds on, nor the retrieval pipeline it may evaluate (code.rag) or the model call itself (code.llm-app). It measures systems; it does not implement them.

## Default Posture

A score is evidence only if the dataset is leak-free, the metric measures the real goal, and the difference is statistically meaningful. A judge is an instrument with bias, not an oracle; every quality claim names what it cannot conclude.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.eval.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
