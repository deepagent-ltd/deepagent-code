# Microsoft Azure Platform

## Boundary

Covers Azure-native services: AKS, Azure Functions, App Service, Blob storage, Entra ID / managed identity, RBAC role assignments, Bicep/ARM, and resource-group topology. Any role assignment or production-resource mutation stops for human review.

## Out of Scope

Generic cloud patterns, raw Kubernetes objects, and Terraform belong to platform.cloud, platform.kubernetes, and platform.terraform. AWS and GCP equivalents are out of scope.

## Default Posture

Read Azure resource and identity configuration freely; treat RBAC role assignments, public exposure, and production mutations as human-gated. Never emit connection strings, SAS tokens, or client secrets.

## Provenance

domain_pack:platform.cloud.azure
