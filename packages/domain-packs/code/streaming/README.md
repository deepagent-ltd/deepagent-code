# Stream Processing (Flink, Kafka Streams, windowing)

## Boundary

Owns continuous processing of unbounded event streams: windowing, watermarks and out-of-order handling, exactly-once semantics, stateful operators, checkpointing, and backpressure. Defers batch modeling and message-bus design.

## Out of Scope

Batch ETL and warehouse modeling belong to code.data-engineering. Broker topology and delivery contracts belong to code.backend.event-driven. Dashboards and alerting belong to code.observability.

## Default Posture

Treat event time, not processing time, as the source of truth; make every operator's state checkpointed and its output idempotent so a recovery replays without duplicating effects.

## Provenance

domain_pack:code.streaming
