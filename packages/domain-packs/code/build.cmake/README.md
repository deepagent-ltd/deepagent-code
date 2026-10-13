# CMake Build System

## Boundary

Covers modern target-based CMake: declaring libraries and executables, expressing usage requirements with PUBLIC/PRIVATE/INTERFACE, resolving dependencies, and configuring out-of-source builds and ctest.

## Out of Scope

It does not cover the C or C++ language semantics of the code being built, nor CI runners or container images, which belong to the code.cpp, code.c, and platform packs.

## Default Posture

Prefer target-based commands with explicit visibility over directory-wide flags, and keep builds out-of-source and reproducible via presets.

## Provenance

domain_pack:code.build.cmake
