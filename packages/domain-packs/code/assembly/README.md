# Assembly Language and Low-Level ABI

## Boundary

This pack governs hand-written and inline assembly and ABI-level work: x86-64 and ARM64/AArch64 instruction sets, register files, calling conventions and the ABI, stack frame layout, addressing modes, inline-asm constraints and clobbers, and reading disassembly. The premise is that the programmer is below the compiler's abstractions and is personally responsible for register and stack discipline that the compiler normally guarantees.

## Out of Scope

It does not cover compiler internals or IR-level optimization (code.compiler), CPU microarchitecture performance tuning of generated code (hardware.cpu-arch), RTL/chip design (hardware.hdl), or kernel APIs (code.os-kernel). It assumes an assembler/linker toolchain and the ability to disassemble and step in a debugger.

## Default Posture

In assembly the safety nets are gone: you own register preservation, stack alignment, and the calling convention, and a single violation corrupts state in ways that surface far from the cause. Follow the target ABI exactly, declare every clobber and side effect to inline-asm constraints, keep the stack aligned, verify behavior by stepping the disassembly, and prefer letting the compiler generate code unless there is a measured, specific reason to write it by hand.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.assembly.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
