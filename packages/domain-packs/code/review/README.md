# Code Review

## Boundary

Read-only code review focused on defects, regressions, risk classification, line evidence, and blocking versus residual risk.

## Out of Scope

Implementation fixes, broad refactors, release approval, or policy certification are outside this pack unless another task explicitly requests them. The pack should not propose patches; it should preserve read-only evidence and report defects, residual risk, and unverified claims.

## Applies When

Use this pack when task evidence, repository signals, or user intent matches: code, review. It contributes refs for max/ultra context admission only; it does not bypass runtime permissions, user approval, or project-specific instructions.

## Evidence Rules

All positive seed documents use medium evidence and must be checked against current repository evidence before use. Review findings require line or symbol evidence, an impact claim, and a severity that follows blast radius rather than reviewer preference. Failure dossiers are diagnostic do-not-use signals and are intentionally excluded from index.json.

## Content Shape

Strategies: 8; methodologies: 5; knowledge: 5; skills: 3; failure dossiers: 5. Counts differ by review behavior: severity, blocking/residual risk, line evidence, negative paths, and read-only report structure.

## L3 Validation

Representative activation and retrieval smoke lives in `evals/smoke/l3-smoke.json`. The quality report lives in `quality/l3-report.json`. A pack reaches L3 only when activation, pack-scoped retrieval, validation smoke, diagnosis smoke, and failure dossier boundaries are all present.
