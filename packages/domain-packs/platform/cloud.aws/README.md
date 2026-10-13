# AWS Cloud Platform

## Boundary

Covers AWS-native services: IAM, Lambda, ECS/Fargate, S3, CloudWatch, and the account/region/AZ topology that surrounds them. Any change that widens an IAM principal or touches a production resource stops for human review.

## Out of Scope

Generic cloud architecture, Kubernetes primitives, and Terraform mechanics belong to platform.cloud, platform.kubernetes, and platform.terraform respectively. GCP and Azure equivalents are out of scope.

## Default Posture

Read and analyze AWS configuration freely; treat IAM widening, S3 public exposure, and any production-resource mutation as human-gated. Never emit access keys or session tokens.

## Provenance

domain_pack:platform.cloud.aws
