# FPGA Toolflow & Timing Closure

## Boundary

Governs the FPGA implementation flow from synthesis through place-and-route, static timing analysis, constraints, and bitstream generation. It covers timing closure, constraint correctness, and the toolchain mechanics that turn RTL into a working device image.

## Out of Scope

It does not cover the functional design of the RTL itself, nor board-level placement of the FPGA package on a PCB.

## Default Posture

Default to constraining every clock and asynchronous crossing before optimizing, and never widen a timing exception to silence a violation without proving it is genuinely false or multicycle. Treat an unconstrained path as a latent failure.

## Provenance

domain_pack:hardware.fpga-toolflow
