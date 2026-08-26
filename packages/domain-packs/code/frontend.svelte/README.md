# Svelte & SvelteKit Frontend

## Boundary

This pack governs Svelte and SvelteKit engineering: the compiler's reactivity model (legacy $: labels and runes like $state/$derived/$effect), stores, SvelteKit routing with load functions, SSR/hydration boundaries, use: actions, and transitions.

## Out of Scope

It does not cover generic DOM/CSS/accessibility (code.frontend.web), the JavaScript language itself (code.javascript), or TypeScript typing rules (code.typescript). It adds Svelte-specific constraints on top of those and never overrides their guidance on the underlying platform.

## Default Posture

Reactivity is driven by the compiler, not by mutation timing, so state changes must go through assignments or runes that the compiler can track. Code that runs on both server and client must produce identical markup, and anything that touches the browser or secrets is kept out of the universal path.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.frontend.svelte.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
