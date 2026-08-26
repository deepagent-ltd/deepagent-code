# PCB Layout & Signal Integrity

## Boundary

Governs printed circuit board layout and signal integrity: layer stackup, controlled-impedance routing, return paths, decoupling, EMI control, and design-rule and electrical-rule checking. It covers the physical and electromagnetic correctness of a board design.

## Out of Scope

It does not cover firmware logic running on the board, nor the schematic-level functional design of the circuit's behavior.

## Default Posture

Default to a continuous reference plane under every high-speed net and run DRC and ERC clean before fabrication. Treat broken return paths and impedance discontinuities as defects, not cosmetic issues.

## Provenance

domain_pack:hardware.pcb
