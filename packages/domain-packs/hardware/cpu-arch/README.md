# CPU Architecture and Microarchitecture Optimization

## Boundary

This pack governs CPU-bound performance work that depends on microarchitecture: cache hierarchy and data locality, branch prediction, instruction pipelines and hazards, SIMD vectorization with SSE/AVX/NEON, the hardware memory model and ordering barriers, false sharing, and NUMA placement. The premise is that wall-clock cost is dominated by memory access patterns and instruction-level parallelism, not raw operation counts.

## Out of Scope

It does not cover algorithmic complexity choices (code.performance proper), RTL or chip design (hardware.hdl), kernel scheduling internals (code.os-kernel), or distributed-system latency. It assumes a profiler with hardware counters (perf, VTune, Instruments) and the ability to read disassembly.

## Default Posture

A microbenchmark that got faster is not proof: measure with hardware performance counters (cache misses, branch mispredicts, IPC) on representative data and inputs. Vectorization and prefetch tuning are last resorts after fixing the access pattern; never reorder memory operations across threads without the correct fence, and never assume the compiler vectorized a loop without checking the emitted assembly.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:hardware.cpu-arch.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
