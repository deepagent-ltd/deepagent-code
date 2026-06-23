# Multi-Tenant Backend

## Boundary

Covers serving many tenants from shared infrastructure: choosing an isolation model, scoping every data access by tenant, preventing cross-tenant leaks, handling noisy neighbors, and routing and configuring per tenant.

## Out of Scope

It does not cover single-tenant authorization rules or general schema design, which belong to backend.auth and code.database; this pack is about keeping tenants' data and load separated.

## Default Posture

Default to strict tenant isolation on every path; treat any code that can reach another tenant's data as a high-severity defect and require a human gate for deliberate cross-tenant access.

## Provenance

domain_pack:code.backend.multi-tenant
