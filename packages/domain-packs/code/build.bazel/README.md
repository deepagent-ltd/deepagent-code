# Bazel Build System

## Boundary

Covers Bazel's build model: writing BUILD files and Starlark rules, structuring the dependency graph with deps and visibility, keeping actions hermetic, and leveraging remote cache and execution for incrementality.

## Out of Scope

It does not cover the runtime behavior of the compiled code or non-Bazel CI orchestration, which belong to language-specific and platform packs.

## Default Posture

Prefer precise, hermetic targets with explicit dependencies so the action graph stays correct and cacheable; treat undeclared inputs as defects.

## Provenance

domain_pack:code.build.bazel
