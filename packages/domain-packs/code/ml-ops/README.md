# MLOps (lifecycle, registry, CI/CD for ML)

## Boundary

Owns the operational lifecycle around a trained model: experiment tracking, registry/versioning, retrain triggers, deployment gates, A/B serving, and lineage. Defers model architecture and training mechanics to code.ml-ai.

## Out of Scope

Model architecture design, loss-function selection, and raw dataset construction belong to code.ml-ai and code.data-engineering. Cluster provisioning belongs to platform.kubernetes.

## Default Posture

Treat every promoted model as an auditable artifact: pinned version, recorded lineage, gated rollout, and a tested rollback path before any production traffic.

## Provenance

domain_pack:code.mlops
