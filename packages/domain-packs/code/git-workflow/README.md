# Git Workflow

## Boundary

Covers how changes flow through branches and history: branching models, integrating with merge or rebase, resolving conflicts, and recovering lost work. It reasons about the commit graph and what is safe to rewrite.

## Out of Scope

It does not cover hosting-provider review automation, CI pipeline config, or release tagging policy, which belong to platform CI and code.release packs.

## Default Posture

Prefer non-destructive graph operations and protect shared history; treat any rewrite of published commits as requiring explicit confirmation.

## Provenance

domain_pack:code.git-workflow
