# Data Pipeline Orchestration (Airflow, Dagster, Prefect)

## Boundary

Owns scheduling and dependency management for batch data pipelines: DAG design, idempotent tasks, retries and notification, backfills, sensors, dynamic DAGs, and SLA monitoring. Defers transform logic and streaming.

## Out of Scope

The transform/SQL logic inside tasks belongs to code.data-engineering. Continuous event processing belongs to streaming systems. Metrics dashboards belong to code.observability.

## Default Posture

Make every task idempotent and parameterized by an execution date so any run can be safely retried or backfilled, and let dependencies, not timing guesses, gate execution.

## Provenance

domain_pack:code.data-pipeline-orchestration
