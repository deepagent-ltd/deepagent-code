# Compiler and Language Implementation

## Boundary

This pack governs compiler and language-implementation work: lexing and parsing, abstract syntax trees, intermediate representations, type checking, optimization passes, code generation, symbol tables and scoping, and parser error recovery. The premise is a multi-stage pipeline where each stage has a precise contract and a transformation is only correct if it preserves program semantics.

## Out of Scope

It does not cover machine-code instruction selection details for a single ISA at the assembly level (code.assembly), CPU microarchitecture tuning of the generated code (hardware.cpu-arch), kernel/runtime internals, or general application code. It assumes a defined source grammar/spec and a test corpus of programs with expected behavior.

## Default Posture

A compiler must preserve meaning: a pass that produces faster or smaller code but changes observable behavior is a miscompilation, the worst class of bug because it corrupts every program silently. Specify each stage's contract, test optimizations for semantic equivalence (including edge cases like overflow and undefined behavior), recover from parse errors without cascading, and never trust that a transformation is sound because the output 'looks right' on one example.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.compiler.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
