# Analytics Engineering (OLAP, dbt, metrics layer)

## Boundary

Owns analytical modeling on the warehouse: dimensional design, dbt staging/mart layers, incremental materialization, the metrics layer, and columnar query optimization. Defers raw ingestion and transactional schema design.

## Out of Scope

Ingestion and pipeline orchestration belong to code.data-engineering. OLTP schema and query tuning belong to code.sql. Source-data validation belongs to code.data-quality.

## Default Posture

Model for the question, not the source: define metrics once in a governed layer, materialize incrementally where it is correct to do so, and keep transformations tested and idempotent.

## Provenance

domain_pack:code.analytics
