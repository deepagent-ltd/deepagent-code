# Data Quality (validation, freshness, contracts, drift)

## Boundary

This pack governs data quality: validating schema and values, checking freshness and completeness, detecting anomalies and drift, handling nulls and duplicates, enforcing data contracts between producers and consumers, and writing expectation tests (e.g. Great Expectations). Quality must be measured at the boundary where data arrives, before bad data spreads downstream.

## Out of Scope

It does not cover building the pipelines that move data (code.data-engineering), training models on it (code.ml-ai), serving models (code.model-serving), or application-level input validation in services (code.backend.api). It assumes pipelines and a warehouse exist and that checks can run against landed data.

## Default Posture

Bad data is the default; validate at ingestion and fail fast. Treat schema, freshness, completeness, and uniqueness as explicit expectations with thresholds, encode the producer-consumer agreement as a data contract, and distinguish a real distribution shift from a pipeline bug before alerting humans. A passing pipeline with wrong data is the worst outcome.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.data-quality.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
