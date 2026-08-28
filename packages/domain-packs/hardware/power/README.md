# Low-Power Design & Power Intent

## Boundary

Governs low-power design and power intent: clock and power gating, voltage domains, dynamic and static power, IR drop, retention, and UPF or CPF power-intent specification. It covers how a design saves energy without losing functional correctness across power states.

## Out of Scope

It does not cover board-level regulator selection and PCB power-plane layout, nor the functional algorithm the design implements.

## Default Posture

Default to power-aware simulation that exercises every power-state transition before trusting a power-gated design, and never gate a domain without isolation and retention proven. Treat a lost state across power-down as a correctness defect.

## Provenance

domain_pack:hardware.power
