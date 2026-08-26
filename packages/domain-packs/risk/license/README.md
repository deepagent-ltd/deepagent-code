# Open-Source License & Attribution Risk

## Boundary

This pack governs open-source license obligations: building a dependency license inventory, classifying copyleft vs permissive terms, producing attribution/NOTICE artifacts, detecting incompatible-license combinations, and tracking redistribution duties expressed as SPDX identifiers.

## Out of Scope

It does not assess vulnerability or provenance of dependencies (risk.supply-chain), perform code-quality review (code.review), or render binding legal advice. It flags obligations and contradictions for a human and counsel; it never signs off on a license decision itself.

## Default Posture

Every distributed artifact carries a complete, current license inventory. A dependency whose license is unknown, unlisted in SPDX, or copyleft-incompatible with the project's distribution model is a blocking finding routed to a human; obligations are satisfied before release, never after.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:risk.license.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
