# PHP, Composer & Laravel/Symfony

## Boundary

This pack governs PHP engineering: Composer dependency and PSR-4 autoload management, PHPUnit testing, the boundary between framework conventions (Laravel, Symfony) and plain PHP, the gradually-typed type system, and exception/error handling.

## Out of Scope

It does not cover language-agnostic engineering practice (code.core) or HTTP/REST API contract design (code.backend.api). It provides PHP-specific toolchain, typing, and framework guidance on top of those and does not restate their generic principles.

## Default Posture

Code is autoloaded via PSR-4 and dependencies are pinned in composer.lock, not loaded ad hoc. Types are declared and strict_types is enabled where the file controls it, errors surface as exceptions rather than silent warnings, and framework magic is used through its documented seams rather than bypassed.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.php.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
