# GitLab CI/CD Pipelines

## Boundary

This pack governs GitLab CI/CD pipeline engineering: stage/job structure in .gitlab-ci.yml, runner selection by tags, cache and artifact handling, protected and masked CI/CD variables, rules/only-except job control, child and parent-child pipelines, and keeping secrets out of job logs and forked-MR runs.

## Out of Scope

It does not author the test suites themselves (code.testing) or own the org-wide dependency and provenance threat model (risk.supply-chain). It tightens but never relaxes the supply-chain or secret constraints inherited from those packs.

## Default Posture

CI/CD variables are protected and masked, jobs run on tagged runners matched to trust level, and secrets never reach merge-request pipelines from forks. Any pipeline change that exposes a protected variable to an unprotected branch, runs untrusted MR code on a privileged runner, or disables masking requires a human gate.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:platform.ci-gitlab.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
