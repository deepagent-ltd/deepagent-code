# Signal Processing & DSP

## Boundary

Governs digital signal processing work: transform selection, filter design, fixed versus floating point datapaths, sampling against Nyquist, and convolution structure. It covers the numerical correctness and frequency-domain behavior of DSP code paths.

## Out of Scope

It does not cover analog front-end electronics layout, RF antenna matching, or general-purpose application logic unrelated to sampled signals.

## Default Posture

Default to floating point reference models first and verify spectra against a known DFT before any fixed-point or vectorized optimization. Treat aliasing and overflow as correctness defects, not tuning knobs.

## Provenance

domain_pack:hardware.signal-processing
