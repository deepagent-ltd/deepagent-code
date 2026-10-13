# Command-Line Interface Engineering

## Boundary

This pack governs command-line interface engineering: argument and flag parsing, subcommand structure, exit codes, the stdin/stdout/stderr streams, TTY-vs-pipe detection, signal handling, help and usage UX, and composability in pipelines. A good CLI behaves predictably both for humans at a terminal and for scripts piping data.

## Out of Scope

It does not cover general program logic (code.core), GUI/TUI rendering frameworks, shell scripting language idioms (code.shell), or packaging/distribution. It assumes the surrounding program and its language runtime already exist.

## Default Posture

A CLI is an API for both humans and machines: send data to stdout and diagnostics to stderr, return meaningful exit codes, detect whether output is a TTY or a pipe before coloring or prompting, and handle signals so a Ctrl-C leaves no half-written output or orphaned children.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.cli.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
