<p align="center">
  <picture>
    <source srcset="assets/logo-dark.svg" media="(prefers-color-scheme: dark)">
    <source srcset="assets/logo-light.svg" media="(prefers-color-scheme: light)">
    <img src="assets/logo-light.svg" alt="DeepAgent Code logo" width="520">
  </picture>
</p>

<p align="center"><strong>AI coding agent with persistent memory and control plane</strong></p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a>
</p>

---

DeepAgent Code is an AI coding agent built on persistent document memory. It keeps [opencode](https://github.com/sst/opencode)'s runtime foundations and adds a control plane for **durable knowledge**, **cross-session memory**, **context assembly**, **learning lifecycle**, and **runtime intelligence**.

## What Makes It Different

**Persistent document system** — Knowledge, decisions, diagnostics, and learnings are stored as typed documents in a searchable graph. The agent builds understanding across sessions instead of starting from scratch each time.

**Project memory sharing** — Multiple conversations within the same project share knowledge, coding patterns, common pitfalls, and build commands. What one session learns becomes available to the next.

**AI IDE microservice** — Query code by symbol name and intent (not file:line coordinates). Get definitions, references, call chains, type hierarchies, and diagnostics in one call. Built on LSP with 38 language servers.

**Preset MCP catalog** — Curated MCP servers for Git platforms, file search, read-only databases, and browser automation. Risk tiers derived at runtime from catalog structure, not user config.

**Domain packs** — Specialized knowledge packages for specific domains (GPU kernels, React, backend APIs, security, testing). Each pack contains typed documents (strategies, methodologies, knowledge, skills) + validation/diagnostic adapters. Packs compose: activate multiple domains for your task.

**Learning lifecycle** — After completing work, the agent can generate candidate memories, facts, strategies, and methodologies. Evidence and approval gates control what gets persisted.

**Work strength ladder** — `general`, `high`, `xhigh`, `max`, `ultra` scale capability without breaking contracts. Higher strengths add control-plane abilities (multi-agent orchestration, adversarial validation) on top of base behavior.

**Scenario modes** — `direct` executes immediately; `wish` refines intent first, shows draft plan, waits for confirmation before automation.

## Installation

```bash
npm install -g deepagent-code
```

Then run:

```bash
deepagent-code
# or use the alias:
deepagent
```

## Quick Example

Start the agent and give it a task:

```bash
deepagent-code "add rate limiting to /api/users endpoint"
```

The agent will:

1. Use LSP to find the endpoint definition and understand its structure
2. Check project memory for existing middleware patterns
3. Implement rate limiting following project conventions
4. Run tests and capture diagnostics
5. Generate a candidate memory: "This project uses express-rate-limit middleware"

On your next session, when you ask to add rate limiting elsewhere, the agent already knows the pattern.

## Core Concepts

**Document graph** — All persistent state lives in typed documents: `knowledge`, `strategy`, `methodology`, `skill`, `memory`, `design`, `worklog`, `diagnosis`, `eval`. Documents link to each other (supports/blocks/conflicts/validates), forming a graph.

**Scope layers** — `session-private` (current conversation), `project-shared` (all sessions in this project), `user-global` (cross-project preferences), `public-system` (built-in skills), `sealed` (audit-only, never enters context).

**Domain packs** — Each pack (e.g., `code.frontend.react`, `code.gpu-kernel`, `risk.security`) is a bundle of typed documents + adapters. Documents include strategies (directions), methodologies (multi-step workflows), knowledge (facts), skills (executable capabilities), and failure dossiers. Packs auto-activate based on problem profile or explicit selection. Core stays domain-neutral.

**Context admission** — Retrieval hits go through admission gates. Sensitive information (SSH hosts, tokens, internal paths) gets suggested but not auto-expanded into prompts.

**Evidence-gated learning** — Learnings require evidence (test pass, diagnostic clear, validation confirmed). Candidates enter a queue; auto-merge or manual review depends on policy.

**Symbol-driven navigation** — Code intelligence tools accept symbol names (e.g., "AgentGateway.open"), not coordinates. The agent resolves names to locations internally via LSP workspace/document symbols.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Control Plane (DeepAgent additions)                        │
│  • Document graph (persistent memory)                       │
│  • Context assembly & admission gates                       │
│  • Learning worker (background, non-blocking)               │
│  • Evidence & approval gates                                │
│  • Work strength orchestration                              │
│  • Domain pack system (composable knowledge)                │
└─────────────────────────────────────────────────────────────┘
                             │
┌─────────────────────────────────────────────────────────────┐
│  Runtime Foundations (from opencode)                        │
│  • Agent loop & tool execution                              │
│  • Session & provider management                            │
│  • MCP client runtime                                       │
│  • Permission system                                        │
└─────────────────────────────────────────────────────────────┘
                             │
┌─────────────────────────────────────────────────────────────┐
│  Intelligence Layers                                        │
│  • LSP microservice (38 language servers)                   │
│  • Preset MCP servers (git/files/db/browser)                │
│  • Domain adapters (validation & diagnostics)               │
│  • Diagnostic & validation loops                            │
└─────────────────────────────────────────────────────────────┘
```

DeepAgent's control plane operates at provider-turn boundaries: it selects context before each model call and writes evidence back into the document graph afterward. It does not replace opencode's runtime—it layers on top.

## Documentation

- [Architecture & Design](design/README.md) — Control plane, code intelligence, MCP security model
- [Security Policy](SECURITY.md) — Vulnerability reporting, known limitations
- [Privacy Policy](PRIVACY.md) — Data handling and storage
- [Contributing](CONTRIBUTING.md) — Development setup and guidelines
- [Changelog](CHANGELOG.md) — Release history

## License & Attribution

DeepAgent Code is licensed under **AGPL-3.0-or-later**. If you modify and run it as a network service, you must make your source code available to users.

This project is derived from [opencode](https://github.com/sst/opencode) (MIT License). See [NOTICE](NOTICE) for the upstream license and attribution. No endorsement by opencode or its contributors is implied.

## Project Status

**V3.4.1** is the first public pre-release hardening milestone. It includes:

- LSP-to-AI-IDE transformation (symbol-driven code intelligence)
- Preset MCP catalog with security model
- License and attribution cleanup
- Secret scan baseline
- Design documentation consolidation

**V3.5** (planned) will add:

- DAP integration (debug adapter protocol for runtime intelligence)
- PAP (performance analysis protocol for profiling: NVIDIA NCU/nsys, AMD rocprof, Intel VTune, CPU perf)
- OS-backed credential storage for MCP servers

---

<p align="center">
  <sub>Built by DeepAgent</sub>
</p>
