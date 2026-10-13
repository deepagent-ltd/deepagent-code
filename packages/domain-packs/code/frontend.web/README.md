# Frontend Web

## Boundary

DOM behavior, CSS layout, responsive viewports, browser APIs, browser smoke, accessibility basics, visible rendering, console/network diagnostics, and visual regression signals.

## Out of Scope

Framework-specific state rules, backend API contracts, performance budgeting, and production release gates belong to their own packs.

## Applies When

Use this pack when task evidence, repository signals, or user intent matches: frontend, web, browser, css, accessibility. It contributes refs for max/ultra context admission only; it does not bypass runtime permissions, user approval, or project-specific instructions.

## Evidence Rules

All positive seed documents use medium evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are intentionally excluded from index.json.

## Content Shape

Strategies: 8; methodologies: 5; knowledge: 8; skills: 4; failure dossiers: 6. The mix is browser-heavy: viewport, DOM semantics, text overflow, console/network evidence, asset/canvas rendering, and keyboard-visible behavior are treated as separate validation surfaces.

## L3 Validation

Representative activation and retrieval smoke lives in `evals/smoke/l3-smoke.json`. The quality report lives in `quality/l3-report.json`. A pack reaches L3 only when activation, pack-scoped retrieval, validation smoke, diagnosis smoke, and failure dossier boundaries are all present.
