# Caching Patterns

## Boundary

Governs application-level caching: cache-aside/through/behind patterns, invalidation, stampede protection, TTL strategy, key design, and multi-layer cache coordination.

## Out of Scope

Not the Redis engine internals (code.database.redis), not edge/CDN runtime specifics (platform.cdn-edge), not general service decomposition (code.backend.service).

## Default Posture

Invalidation correctness and key cardinality are the dominant failure axes: assume every cached copy is stale until proven fresh, and bound the key space before tuning the TTL.

## Provenance

domain_pack:code.caching
