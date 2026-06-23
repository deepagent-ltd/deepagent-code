# Real-Time Graphics (Rendering, Shaders, GPU Pipeline)

## Boundary

This pack governs real-time graphics rendering: the rasterization pipeline (vertex -> primitive -> fragment), shader programs in GLSL/HLSL/WGSL, coordinate-space transforms and matrices, textures and samplers, framebuffers and render targets, depth/blend state, and frame timing on OpenGL/Vulkan/WebGPU. Rendering is a fixed-stage pipeline feeding programmable shader stages that run massively in parallel across vertices and fragments.

## Out of Scope

It does not cover GPU compute kernels for general numeric work (code.gpu-kernel owns CUDA/compute), CPU-side algorithmic optimization beyond the draw path (code.performance), windowing/input plumbing, or 3D content authoring. It assumes a working graphics context, swapchain, and build toolchain exist.

## Default Posture

The GPU runs the same shader over millions of vertices and fragments in parallel; correctness and performance are dominated by data layout, state transitions, and synchronization, not clever per-pixel logic. A frame that looks right on one driver can be undefined on another, so treat validation-layer errors, undefined behavior in shaders, and unsynchronized resource hazards as blocking. Never assume execution order across invocations or trust visual inspection as proof of correctness.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.graphics.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
