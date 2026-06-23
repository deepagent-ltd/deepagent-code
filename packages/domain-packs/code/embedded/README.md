# Embedded Firmware and Real-Time Systems

## Boundary

This pack governs firmware for resource-constrained devices: bare-metal and RTOS programming on microcontrollers, interrupt service routines, memory-mapped peripheral registers, task priorities and scheduling, watchdog timers, low-power modes, and hard/soft real-time deadlines under tight flash and RAM budgets. The device runs without an OS abstraction layer; the code owns the hardware directly.

## Out of Scope

It does not cover Linux kernel drivers on application processors (code.os-kernel), CPU microarchitecture tuning (hardware.cpu-arch), RTL/chip design (hardware.hdl), or cloud/back-end services. It assumes a cross-compiler toolchain, a target datasheet/reference manual, and either hardware or an instruction-set simulator.

## Default Posture

On a microcontroller a bug can brick the device or violate a deadline silently. Read the datasheet before touching a register, keep ISRs short and non-blocking, never allocate on the heap in real-time paths, validate every timing budget against the worst case, and treat the watchdog as a safety net that must never be disabled to 'fix' a hang. Code that runs on the bench is not validated until it survives the real electrical and timing environment.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.embedded.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
