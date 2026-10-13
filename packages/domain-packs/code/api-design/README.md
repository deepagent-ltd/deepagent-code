# API Design

## Boundary

Covers the design of an API surface: modeling resources, naming and consistency, choosing a versioning and evolution strategy, pagination and error-envelope shape, idempotency semantics, and contract-first specification.

## Out of Scope

It does not cover the server implementation, routing, or persistence of an endpoint, which belong to the code.backend.api pack; this pack reasons about the contract, not the code behind it.

## Default Posture

Design contracts that are consistent, evolvable, and explicit about errors and idempotency, favoring additive change over breaking change.

## Provenance

domain_pack:code.api-design
