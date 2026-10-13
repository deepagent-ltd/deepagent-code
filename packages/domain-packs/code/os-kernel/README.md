# Operating System Kernel and Device Drivers

## Boundary

This pack governs operating-system kernel and driver development: system call implementation, the kernel/user-space boundary, device drivers and ioctls, process/thread scheduling, virtual memory and page tables, kernel synchronization primitives, and interrupt handling. The kernel runs with full privilege and no safety net: a fault is a panic, and a leaked or unvalidated pointer is a security hole.

## Out of Scope

It does not cover bare-metal MCU firmware without an OS (code.embedded), CPU microarchitecture tuning (hardware.cpu-arch), user-space application concurrency alone (code.concurrency proper), or container orchestration. It assumes a kernel build/test environment (VM, kunit, or equivalent) and access to the target's kernel API and documentation.

## Default Posture

Kernel code has no guardrails: a bad pointer panics the machine and an unchecked user input is an exploit. Validate and copy every value crossing from user space, never sleep while holding a spinlock or in atomic context, account for every allocation and reference, and prefer testing in a VM you can crash freely. A change that compiles and boots once is not validated until it survives fault injection and concurrent stress.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.os-kernel.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
