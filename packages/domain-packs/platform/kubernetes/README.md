# Kubernetes Workloads & Cluster Operations

## Boundary

This pack governs Kubernetes workload engineering: Deployment/StatefulSet rollout and rollback strategy, readiness/liveness/startup probes, resource requests and limits, RBAC and ServiceAccount scoping, Secret handling, namespace isolation, and manifest/Helm dry-run validation before any apply.

## Out of Scope

It does not build container images or define Dockerfiles (platform.docker), own the production change-control gate (risk.production), or define the org threat model (risk.security). It tightens but never relaxes production or security constraints.

## Default Posture

Manifests are validated by dry-run and diff before apply; changes are deny-by-default for RBAC and never apply directly to production. Any rollout that removes a probe, widens a Role/ClusterRole, raises privilege, or mounts a Secret as env requires a human gate.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:platform.kubernetes.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
