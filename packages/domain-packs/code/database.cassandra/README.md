# Cassandra / Wide-Column Engine

## Boundary

Covers the Cassandra/ScyllaDB wide-column engine: query-first partition modelling, clustering columns, tombstones and compaction, tunable consistency, denormalization, and the cost of LWT. Generic data modelling lives in code.database and distributed-systems theory in code.distributed.

## Out of Scope

Relational joins, foreign keys, ad-hoc querying, and ACID multi-partition transactions are out of scope; Cassandra deliberately trades them for linear write scalability and availability.

## Default Posture

Default to modelling one table per query, choosing partition keys that bound size and spread load, and tunable consistency (often QUORUM); treat ALLOW FILTERING and unbounded partitions as defects.

## Provenance

domain_pack:code.database.cassandra
