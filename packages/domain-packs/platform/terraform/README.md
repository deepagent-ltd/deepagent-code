# Terraform & Infrastructure as Code (HCL)

## Boundary

This pack governs Terraform and HCL-based infrastructure as code: provider and resource declaration, remote state and locking, the plan/apply lifecycle, modules and composition, drift detection, importing existing infrastructure, and keeping secrets out of state. Terraform is declarative: you describe desired state and the engine computes a diff.

## Out of Scope

It does not cover cloud-provider service architecture trade-offs (platform.cloud), imperative configuration management (Ansible/Chef), Kubernetes manifests (platform.kubernetes), or credential issuance. It assumes a configured backend and provider credentials already exist.

## Default Posture

Infrastructure changes are high-blast-radius and often irreversible: never apply without reviewing a saved plan, never edit state by hand without a backup, treat state as secret-bearing, and require human approval before any apply that destroys or replaces resources.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:platform.terraform.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
