# Backend Authentication & Authorization

## Boundary

This pack governs authentication and authorization engineering: identity verification, session/token lifecycle, permission models (RBAC/ABAC), tenant scoping, and the negative-permission tests that prove access is actually denied.

## Out of Scope

It does not cover generic REST/GraphQL shape (code.backend.api), cryptographic primitive design, the full threat model (risk.security), or database row storage (code.database). It may add stricter constraints but never relaxes risk.security or risk.privacy.

## Default Posture

Authorization is deny-by-default and enforced server-side. Any change that widens access, weakens a permission check, lengthens a session, or trusts a client-supplied identity claim requires a negative test proving denial and a human gate.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.backend.auth.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
