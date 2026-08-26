# Google Cloud Platform

## Boundary

Covers GCP-native services: Cloud Run, GKE, BigQuery, Cloud Functions, GCS, and the IAM binding/service-account/workload-identity model that ties them together. Granting an IAM role or mutating a production resource stops for human review.

## Out of Scope

Generic cloud patterns, raw Kubernetes objects, and Terraform live in platform.cloud, platform.kubernetes, and platform.terraform. AWS and Azure equivalents are out of scope.

## Default Posture

Inspect GCP project configuration freely; treat IAM role grants, public access, and any production mutation as human-gated. Never emit service-account keys or OAuth tokens.

## Provenance

domain_pack:platform.cloud.gcp
