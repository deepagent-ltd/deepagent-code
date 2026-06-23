# Time-Series Databases

## Boundary

Governs time-series storage engines (TimescaleDB, InfluxDB, Prometheus TSDB): chunking, downsampling, retention, tag cardinality, and time-bucketed queries.

## Out of Scope

Not generic relational schema (code.database), not metric-rule authoring (platform.monitoring), not app instrumentation (code.observability).

## Default Posture

Tag/label cardinality is the dominant failure axis: treat unbounded label values as a capacity risk and downsample before retention windows blow up storage.

## Provenance

domain_pack:code.database.timeseries
