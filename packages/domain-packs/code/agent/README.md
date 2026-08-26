# Agent Loop & Tool Orchestration

## Boundary

This pack governs autonomous and multi-step agents: the perceive-decide-act loop and its termination, the tool registry and per-tool permissioning, context-window budgeting, durable memory/state, and MCP server/client integration.

## Out of Scope

It does not own the single model call itself (code.llm-app), retrieval and grounding (code.rag), or evaluation harnesses (code.eval). It defers PII handling to risk.privacy and never weakens it; it adds loop-safety constraints on top of the model-call contract.

## Default Posture

The runner is the source of truth, not the model's narration of what it did. Every loop has a step cap and a no-progress guard; every tool is registered with explicit permissions; context is budgeted and memory writes are deliberate, not append-everything.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.agent.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
