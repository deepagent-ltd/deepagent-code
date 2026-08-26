# Distributed Systems (Consensus, Replication, Consistency)

## Boundary

This pack governs distributed-systems engineering: consensus protocols (Raft, Paxos, Multi-Paxos), state-machine replication, consistency models (linearizable, sequential, causal, eventual), quorum systems, leader election, partition tolerance, and reasoning about time without a global clock. The core fact is that the network can delay, reorder, duplicate, and drop messages, and nodes can crash at any point.

## Out of Scope

It does not cover single-node datastore internals (code.databases), the wire protocols themselves (code.networking owns TCP/TLS framing), application service handlers (code.backend.service), or metrics plumbing (code.observability). It assumes durable per-node storage and a message transport already exist.

## Default Posture

Assume the network is asynchronous and adversarial: messages can be lost, delayed, and reordered, and any node can fail mid-operation. Never trust wall-clock time for ordering or correctness. A protocol that passes on a healthy cluster proves nothing; correctness must hold under partitions, message loss, and concurrent leaders. Treat split-brain and silent data divergence as the default failure to design against.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.distributed.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
