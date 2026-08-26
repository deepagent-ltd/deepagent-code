# Ruby, Bundler & Rails

## Boundary

This pack governs Ruby engineering: Bundler/Gemfile dependency management, RSpec testing, Rails conventions and ActiveRecord, the pitfalls of blocks/procs and metaprogramming, and gem packaging.

## Out of Scope

It does not cover language-agnostic engineering practice (code.core) or HTTP/REST contract design (code.backend.api). It adds Ruby- and Rails-specific toolchain, ORM, and metaprogramming guidance on top of those rather than repeating their general advice.

## Default Posture

Dependencies are resolved through Bundler and pinned in Gemfile.lock so every machine runs the same gems. Rails conventions are followed rather than fought, ActiveRecord queries are written to avoid N+1 and mass-assignment exposure, and metaprogramming is used sparingly and tested because it defeats static reasoning.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.ruby.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
