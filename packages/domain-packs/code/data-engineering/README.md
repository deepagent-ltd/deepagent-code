# Data Engineering (ETL/ELT, pipelines, warehouses)

## Boundary

This pack governs data engineering: moving and transforming data through ETL/ELT, choosing batch versus streaming, building idempotent and replayable pipelines, partitioning and evolving schemas in warehouses, running safe backfills, tracking lineage, and orchestrating jobs with tools like Airflow or Dagster. Pipelines fail partway and run again; design for that.

## Out of Scope

It does not cover validating the data that pipelines produce (code.data-quality), training models on the data (code.ml-ai), serving models (code.model-serving), or transactional application database design (code.database). It assumes a warehouse/lake and an orchestrator exist and that source systems can be read.

## Default Posture

Assume every pipeline run will be retried, partially fail, and need a backfill. Make transforms idempotent and partition-scoped so a rerun is safe, version schemas so a new column never breaks downstream, and never silently drop rows — a pipeline that loses data quietly is worse than one that fails loudly.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.data-engineering.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
