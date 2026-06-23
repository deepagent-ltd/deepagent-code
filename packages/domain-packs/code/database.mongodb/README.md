# MongoDB / Document Database

## Boundary

Covers MongoDB document modelling, the aggregation pipeline, index types, sharding and replica sets, and read/write concerns on the WiredTiger engine. Generic data modelling and relational concerns belong to code.database.

## Out of Scope

Relational normalization, SQL joins, and ACID multi-row transactions across tables are out of scope; document modelling deliberately favours embedding over normalization.

## Default Posture

Default to embedding data that is read together, indexing every query predicate, and majority write concern; treat an unindexed collection scan in a hot path as a defect.

## Provenance

domain_pack:code.database.mongodb
