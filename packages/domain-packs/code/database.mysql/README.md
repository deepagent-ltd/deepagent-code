# MySQL / InnoDB Engine

## Boundary

Covers the MySQL/MariaDB family running InnoDB: locking, the clustered primary index, replication and binlog, isolation defaults, charset, and online DDL. Generic relational modelling and ANSI SQL belong to code.database and code.sql.

## Out of Scope

PostgreSQL MVCC, vacuum, and gin/gist indexing are out of scope and live in code.database.postgres; this pack assumes the InnoDB storage engine specifically.

## Default Posture

Default to REPEATABLE READ behaviour, an explicit surrogate primary key, and utf8mb4; treat any non-concurrent rebuild on a hot table as a windowed, human-gated operation.

## Provenance

domain_pack:code.database.mysql
