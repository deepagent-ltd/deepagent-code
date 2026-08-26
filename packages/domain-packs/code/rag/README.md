# Retrieval-Augmented Generation

## Boundary

This pack governs retrieval-augmented generation: chunking documents, choosing embeddings and a vector index, retrieving and reranking candidates, and grounding the answer in retrieved passages with citations the user can check.

## Out of Scope

It does not own the model call mechanics (code.llm-app), generic keyword/search infrastructure (code.search), or the evaluation harness internals (code.eval) it relies on to measure retrieval quality. It defers PII in source documents to upstream privacy controls.

## Default Posture

An answer is grounded only when each claim traces to a retrieved passage; missing grounding means the model must abstain, not invent. Retrieval quality is measured, not assumed, and context is curated to fit, never stuffed past the window.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.rag.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
