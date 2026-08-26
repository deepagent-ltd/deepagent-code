# E-Commerce Cart and Order Flow

## Boundary

Governs e-commerce transactional flow: cart and checkout state machines, inventory reservation, order lifecycle transitions, idempotent payment handling, and refund/cancellation paths.

## Out of Scope

Advisory only on money movement — settlement, ledgering, and payout deferring to business.finance with a human gate; API plumbing belongs to code.backend.api and schema to code.database.

## Default Posture

Stock and money are the high-risk axes: reserve inventory before promising it, make every payment and state transition idempotent, and never move money without deferring to business.finance under human approval.

## Provenance

domain_pack:business.ecommerce
