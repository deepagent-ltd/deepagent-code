# Helm Charts

## Boundary

Covers Helm chart authoring and operations: template/values/_helpers structure, values precedence, upgrade/rollback/release history, helm template debugging, subcharts and dependencies, hooks, and schema validation.

## Out of Scope

Raw Kubernetes object design and cluster policy belong to platform.kubernetes. Cloud-specific resources, CI pipelines, and Terraform are out of scope.

## Default Posture

Render, lint, and diff charts freely; production helm upgrade/rollback against a live release is human-gated. Never template real secret values into rendered manifests.

## Provenance

domain_pack:platform.helm
