# Privacy Risk Controls

## Boundary

This pack makes DeepAgent conservative around PII, PHI, PCI, indirect identifiers, data inventory, minimization, retention, redaction, consent/preference signals, export/delete behavior, logging privacy, prompts, artifacts, and external processors. It supports engineering review, implementation shaping, validation planning, and human-gate escalation.

## Out of Scope

This pack does not provide legal advice, compliance certification, consent-language approval, vendor-contract approval, or permission to inspect real personal data. Business, legal, healthcare, finance, and production owners may add stricter constraints but must not loosen these privacy controls.

## Default Posture

Treat unknown data class, unknown sink, unknown retention, or unknown user-rights impact as a blocker or human-gate condition. Do not broaden collection, expose personal data, send data to new processors, or put real data in prompts without explicit approval.

## Evidence Rules

Positive documents are indexed only for max/ultra, except skills which may be listed for high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are intentionally excluded from index.json.

## Provenance

Content is domain-pack seed material derived from privacy engineering practice around minimization, redaction, retention, and user-rights boundaries; provenance_tag is domain_pack:risk.privacy.

## L3 Validation

Representative activation and retrieval smoke lives in `evals/smoke/l3-smoke.json`. The quality report lives in `quality/l3-report.json`. A pack reaches L3 only when activation, pack-scoped retrieval, validation smoke, diagnosis smoke, and failure dossier boundaries are all present.
