# Hardware Description Languages (Verilog/SystemVerilog/VHDL)

## Boundary

This pack governs hardware description language engineering: RTL design in Verilog/SystemVerilog/VHDL, synthesizable subsets, clock-domain crossing, finite state machines, self-checking testbenches, assertions, and FPGA/ASIC timing closure. Hardware is concurrent: every block runs each cycle in parallel.

## Out of Scope

It does not cover CPU microarchitecture trade-offs (hardware.cpu-arch), board-level firmware (code.embedded), analog/mixed-signal design, or vendor-tool installation. It assumes a simulator (Verilator/Icarus/ModelSim) and a synthesis flow exist.

## Default Posture

RTL is hardware, not software: a clean compile or a passing waveform is not correctness. Require self-checking testbenches with assertions/scoreboards, treat synthesis lint (inferred latch, multi-driver, unconstrained CDC) as blocking, and never rely on initial blocks or delays for ASIC behavior.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:hardware.hdl.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
