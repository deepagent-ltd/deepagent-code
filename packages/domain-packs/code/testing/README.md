# Code Testing

## Boundary

Test selection, regression tests, fixtures, coverage gaps, flake isolation, and test-output interpretation.

## Out of Scope

This pack does not define product behavior, perform root-cause diagnosis, set security policy, or decide production rollout criteria. It supplies validation choices and test evidence; debugging owns cause isolation after a failure is reproduced.

## Applies When

Use this pack when task evidence, repository signals, or user intent matches: code, testing. It contributes refs for max/ultra context admission only; it does not bypass runtime permissions, user approval, or project-specific instructions.

## Evidence Rules

All positive seed documents use medium evidence and must be checked against current repository evidence before use. Testing claims need command, runner output, fixture intent, or coverage artifact references. Failure dossiers are diagnostic do-not-use signals and are intentionally excluded from index.json.

## Content Shape

Strategies: 8; methodologies: 7; knowledge: 5; skills: 3; failure dossiers: 5. Counts focus on focused test selection, runner output, fixture design, flake handling, coverage limits, and negative-path validation.

## L3 Validation

Representative activation and retrieval smoke lives in `evals/smoke/l3-smoke.json`. The quality report lives in `quality/l3-report.json`. A pack reaches L3 only when activation, pack-scoped retrieval, validation smoke, diagnosis smoke, and failure dossier boundaries are all present.
