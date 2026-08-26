# WebAssembly: Build, Interop & Runtimes

## Boundary

This pack governs WebAssembly engineering: choosing build targets and toolchains, the JS<->WASM interop boundary and ABI, the linear memory model and ownership across that boundary, bundling/loading the module, the differences between browser and WASI runtimes, and debugging compiled WASM.

## Out of Scope

It does not own general Rust language design (code.rust) or browser DOM/app architecture (platform.web); it depends on those for source-language idioms and page integration while adding WASM-specific compilation, ABI, and runtime reasoning.

## Default Posture

The build target matches the runtime (browser vs WASI), values cross the JS boundary through a typed binding layer rather than raw pointers, and memory ownership across the boundary is explicit so nothing is freed twice or leaked. Any change that hand-rolls the ABI, shares a detached memory buffer, or mixes runtime targets requires verification against the actual runtime.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.wasm.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
