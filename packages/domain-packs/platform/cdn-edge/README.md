# CDN & Edge Compute

## Boundary

Governs CDN and edge-compute concerns: cache-control/surrogate keys, edge functions (Cloudflare Workers, Lambda@Edge) and their runtime limits, purge/invalidation, origin shielding, and edge-vs-origin logic placement.

## Out of Scope

Not application-layer caching internals (code.caching), not network transport (code.networking), not browser render metrics (code.frontend.performance).

## Default Posture

The edge is a distributed cache with weak invalidation guarantees: treat cache-control headers as the contract, never assume instant global purge, and keep edge functions within their tight CPU/memory/no-filesystem limits.

## Provenance

domain_pack:platform.cdn-edge
