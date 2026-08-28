# Regulated Compliance, Audit & Change Control

## Boundary

This pack governs operating in regulated environments: capturing tamper-evident audit trails, enforcing change-approval gates, preserving segregation of duties, retaining evidence for control frameworks (SOC 2, GDPR, HIPAA-style), and proving via attestation that a control actually ran.

## Out of Scope

It does not define the data-privacy rules themselves (risk.privacy), the threat model and security controls (risk.security), or the line-level code review (code.review). It enforces that the process around a change is evidenced and gated; it never authors the regulation or replaces an auditor's or counsel's judgment.

## Default Posture

No change to a regulated system is self-approved and none is undocumented. Every controlled action emits durable, tamper-evident evidence, passes an approval gate by a different principal than the author, and is blocked until that evidence exists. Production deploys and control-disabling actions are denied to the agent and require a human gate.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:risk.compliance.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
