# DeepAgent Code System Manual

## Boundary

This pack is the operator's manual for DeepAgent Code itself, written for the model that runs inside it: how to delegate work to subagents and merge their isolated output back, how to query code intelligence and cross-graph context, how to survive compaction and budget pressure, what permission denials mean, and what session reliability notices (revert, rollback) require. Every document describes shipped behavior only.

## Out of Scope

It does not cover general software domains (the other built-in packs do), model-provider configuration, or UI operation. Unshipped surfaces are never documented here: there is no knowledge write tool today, so the manual describes the read path (capability_search, pack_search, domain_pack_load) and the human review queue concept only.

## Default Posture

Delegate self-contained chunks with declared file scopes; never assume a write-type subagent's changes are in your workspace — they live on a `deepagent-code/task-*` branch until pr_finalize merges them. Treat compaction summaries and prior memory as notes to re-verify with tools. A denial is a user decision, never a transient error.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and describe the behavior of the shipped tools at authoring time. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:deepagent.dac-manual.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
