# Hardware Serial & Bus Protocols

## Boundary

Governs the framing, timing, and transaction semantics of hardware serial and bus protocols including I2C, SPI, UART, CAN, USB, and PCIe. It covers wire-level correctness, addressing, acknowledgement, and enumeration of peripheral links.

## Out of Scope

It does not cover application-layer network protocols such as TCP or HTTP, nor physical connector mechanics and cable manufacturing.

## Default Posture

Default to a logic-analyzer capture of the actual bus before trusting driver logic, and treat timing and acknowledgement violations as wire-level defects. Prefer the slowest reliable clock during bring-up.

## Provenance

domain_pack:hardware.protocols
