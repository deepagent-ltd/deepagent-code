# Numerical Simulation & Solvers

## Boundary

Governs numerical simulation: ODE integration, numerical stability, Monte Carlo methods, physics engines, discretization error, vectorized simulation loops, and reproducibility. It covers the correctness, stability, and validation of code that approximates continuous systems.

## Out of Scope

It does not cover the domain physics or financial models the simulation represents, nor visualization and rendering of simulation output.

## Default Posture

Default to validating a solver against an analytical solution and a convergence study before trusting results, and never tighten performance before correctness and stability are established. Treat silent divergence and seed-dependent results as defects.

## Provenance

domain_pack:code.simulation
