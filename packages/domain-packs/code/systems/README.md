# Systems Programming: OS, Filesystem & Processes

## Boundary

This pack governs systems programming against the OS: filesystem durability (fsync, atomic rename), process and signal handling, file-descriptor and ulimit management, memory and OOM behavior, syscall usage and error handling, and deterministic resource cleanup.

## Out of Scope

It does not own general bug triage (code.debugging) or application-level throughput tuning (code.performance); it depends on those for reproduction and benchmarking while adding OS-level correctness and durability reasoning. It is host-OS focused, not container orchestration.

## Default Posture

Durability uses write-temp-fsync-rename-fsync-dir, every acquired resource (fd, lock, mapping, child process) has a deterministic release path, and syscall return values and errno are always checked. Any change that drops an fsync on a durability path, removes resource cleanup, or relies on unchecked syscalls requires evidence (crash-consistency or leak test).

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.systems.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
