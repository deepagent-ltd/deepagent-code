# Hardware Verification & Coverage

## Boundary

Governs functional verification of digital hardware: UVM testbench construction, constrained-random stimulus, functional coverage, formal property checking, assertions, and coverage closure including clock-domain and reset-domain verification. It covers how a design is proven correct before tapeout.

## Out of Scope

It does not cover the RTL design under test itself, nor software-level unit testing of application code unrelated to hardware.

## Default Posture

Default to coverage-driven verification where stimulus is randomized and progress is measured by functional coverage, and never claim a feature verified without coverage evidence. Treat an unchecked corner as unverified, not passing.

## Provenance

domain_pack:hardware.verification
