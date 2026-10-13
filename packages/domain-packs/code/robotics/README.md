# Robotics (ROS/ROS2, Control, Sensing)

## Boundary

This pack governs robotics software: ROS/ROS2 node and topic architecture, real-time control loops (PID and beyond), sensor fusion and state estimation, coordinate frames and transform trees (tf/tf2), actuator command and limits, safety stops, and timing determinism. The defining reality is that the software drives physical actuators that can injure people or damage hardware, on a deadline that cannot slip.

## Out of Scope

It does not cover low-level OS/driver internals (code.systems), generic threading primitives beyond the control context (code.concurrency), or transport wire formats (code.networking owns DDS/TCP framing). It also does not provide mechanical or electrical engineering design. It assumes a robot model, ROS distribution, and either hardware or a simulator (Gazebo) exist.

## Default Posture

The code moves physical mass, so safety and timing come before features: every actuator path must respect limits and an emergency stop, control loops must meet their deadline deterministically, and sensor data must be fused and time-stamped correctly. A behavior that works once in simulation is not validated; require deterministic timing evidence, frame-correctness checks, and a tested safety stop before commanding real hardware, which this pack never does automatically.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.robotics.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
