# Angular & RxJS Frontend

## Boundary

This pack governs Angular engineering: dependency injection and providers, the module/standalone-component boundary, RxJS observable composition and subscription lifecycle, change detection (Zone.js vs OnPush vs signals), and reactive forms.

## Out of Scope

It does not cover generic DOM/CSS/accessibility (code.frontend.web) or the TypeScript type system itself (code.typescript). It layers Angular-specific dependency, reactivity, and change-detection rules on top of those and never relaxes the platform guidance beneath it.

## Default Posture

Subscriptions and change detection are managed deliberately: streams are composed and unsubscribed rather than left running, and components default to OnPush or signals so the framework re-renders on explicit inputs, not on every async tick. Injectables declare their scope rather than relying on accidental singletons.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.frontend.angular.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
