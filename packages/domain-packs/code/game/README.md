# Game Engine & Real-Time Simulation

## Boundary

This pack governs real-time game engineering: the game loop and fixed-timestep update, entity-component-system architecture, physics and collision, the per-frame time budget, the asset pipeline, input handling, and determinism for replay and netcode. Games run a tight loop where every millisecond of the frame budget is contested.

## Out of Scope

It does not cover general rendering/GPU theory (code.graphics), micro-optimization unrelated to frames (code.performance), shader authoring detail, or storefront/publishing. It assumes an engine or framework (Unity/Unreal/Godot/custom) and a renderer already exist.

## Default Posture

The frame is the unit of correctness: decouple simulation from rendering with a fixed timestep so physics is stable and deterministic, treat the frame budget as a hard deadline (16.6 ms at 60 FPS), and never let per-frame allocations or blocking I/O cause a stall the player sees as a hitch.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.game.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
