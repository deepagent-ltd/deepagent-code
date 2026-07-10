# MCP Integration

## Boundary

MCP server/tool integration, capability schemas, permission boundaries, tool invocation audit, and validation fixtures.

## Out of Scope

Does not bypass runtime permission gates or import external tool servers blindly.

## Source Basis

Derived from reviewed skill survey outputs, including canonical rules, coverage reports, and trusted skill notes. Paraphrased into domain-pack seed form.

## Composition

Depends on: code.backend.api, risk.security. This pack should compose with more specific language, framework, risk, or platform packs; it does not override them.

## Content Shape

Strategies: 6; methodologies: 4; knowledge: 5; skills: 3; failure dossiers: 4.

## L3 Validation

Representative activation and retrieval smoke lives in `evals/smoke/l3-smoke.json`. The quality report lives in `quality/l3-report.json`. A pack reaches L3 only when activation, pack-scoped retrieval, validation smoke, diagnosis smoke, and failure dossier boundaries are all present.
