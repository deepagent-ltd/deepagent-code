# GitHub Actions CI Workflows

## Boundary

This pack governs GitHub Actions workflow engineering: workflow/job/step structure, matrix builds, cache and artifact handling, GITHUB_TOKEN permission scoping, third-party action pinning by commit SHA, untrusted-PR trigger safety, and OIDC-based cloud auth in place of long-lived secrets.

## Out of Scope

It does not author or run the test suites themselves (code.testing) or own the org-wide dependency and provenance threat model (risk.supply-chain). It tightens but never relaxes supply-chain or secret constraints inherited from those packs.

## Default Posture

GITHUB_TOKEN is least-privilege (permissions: read-all unless a job needs write), third-party actions are pinned to a full commit SHA, and secrets never reach untrusted PR code. Any workflow that adds pull_request_target with checkout of the PR head, widens token permissions, or exposes a secret to a fork requires a human gate.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:platform.ci-github.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
