# Security Risk Controls

## Boundary

This pack makes DeepAgent conservative around authorization, injection, dangerous sinks, secrets, supply-chain deltas, least privilege, server-side enforcement, negative security tests, and audit evidence. It can guide analysis, implementation review, test planning, and human-gate escalation.

## Out of Scope

This pack does not provide exploit instructions, framework-specific recipes, legal compliance certification, cryptographic design approval, production access, or permission relaxation. More specific framework, platform, supply-chain, privacy, and production packs may add stricter constraints but must not loosen these controls.

## Default Posture

Treat missing evidence as deny or escalate. Any permission expansion, secret exposure, new dangerous sink, dependency execution, production-facing security control change, or ambiguous policy decision requires a human gate. Passing happy-path tests is not enough for security closure.

## Evidence Rules

Positive documents are indexed only for max/ultra, except skills which may be listed for high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are intentionally excluded from index.json.

## Provenance

Content is domain-pack seed material derived from common secure-engineering review practice and paraphrased OWASP-style control themes; provenance_tag is domain_pack:risk.security.

## L3 Validation

Representative activation and retrieval smoke lives in `evals/smoke/l3-smoke.json`. The quality report lives in `quality/l3-report.json`. A pack reaches L3 only when activation, pack-scoped retrieval, validation smoke, diagnosis smoke, and failure dossier boundaries are all present.
