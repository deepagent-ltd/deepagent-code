<p align="center">
  <picture>
    <source srcset="assets/logo-dark.svg" media="(prefers-color-scheme: dark)">
    <source srcset="assets/logo-light.svg" media="(prefers-color-scheme: light)">
    <img src="assets/logo-light.svg" alt="DeepAgent Code logo" width="520">
  </picture>
</p>

<p align="center"><strong>A document-centered AI coding agent with a durable control plane.</strong></p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a>
</p>

---

## What is DeepAgent Code?

DeepAgent Code is an AI coding agent built around a durable document system. It keeps the proven opencode runtime, tool, MCP, session, and provider foundations, then adds the DeepAgent control plane for document memory, context assembly, retrieval gates, learning, failure triage, domain adapters, and runtime intelligence.

The guiding idea is simple: the document system is the agent's durable body. Knowledge, strategy, methodology, skills, memory, diagnosis, decisions, work logs, and context snapshots are represented as typed documents. The context layer selects the smallest useful slice for each model turn, then writes new evidence back into the document graph.

DeepAgent Code is not presented as an upstream-endorsed opencode release. It is a derived work with substantial DeepAgent changes.

## Highlights

- **Document graph**: typed documents for durable knowledge, working memory, decisions, diagnostics, snapshots, skills, and methodologies.
- **Context control**: deterministic context admission at safe provider-turn boundaries, bounded tool output, evidence-gated retrieval, and conflict-aware memories.
- **Work strengths**: `general`, `high`, `xhigh`, `max`, and `ultra` form a capability ladder; higher strengths add control-plane abilities without silently changing lower-mode contracts.
- **Scenario modes**: `direct` executes the user's prompt immediately; `wish` first refines and confirms intent before stronger automation.
- **AI IDE microservice**: code intelligence via LSP-style symbol search, diagnostics, and source navigation entry points.
- **Preset MCP catalog**: curated MCP server presets for Git platforms, file search, read-only database access, and browser/fetch workflows.
- **Learning lifecycle**: completed work can produce candidate memories, facts, failure dossiers, strategies, and methodologies under evidence and approval gates.

## Installation

```bash
npm i -g deepagent-code@latest
# or
bun add -g deepagent-code
```

Then run:

```bash
deepagent-code
# alias:
deepagent
```

The package also exposes project-specific packages in this monorepo for the app, server, SDK, TUI, desktop shell, and supporting services.

## Quick start

```bash
# Start the agent in the current repository
deepagent-code

# Start with a prompt
deepagent-code "inspect this repo and explain the architecture"
```

Common local development commands:

```bash
bun install
bun run typecheck
bun run --cwd packages/deepagent-code test
bun run dev
```

## Language support

The application UI is internationalized. The officially maintained repository README files are:

- [English](README.md)
- [简体中文](README.zh.md)

Other UI translations may exist in the product, but non-English README translations are not maintained in this repository unless explicitly marked as official.

## Security and MCP credentials

DeepAgent Code includes a preset MCP catalog with risk tiers derived at runtime from catalog templates, not from user-writable configuration. Read-only database presets are intended to be conservative and still include SQL guardrails.

Known limitation for V3.4.1: enabling preset MCP servers that require credentials may store those credential values in local configuration. Do not commit configuration files containing secrets. The planned V3.5 M-CRED work moves credentials behind OS-backed secret storage and runtime environment resolution.

See [SECURITY.md](SECURITY.md) for reporting instructions, security model notes, and source availability information.

## Source availability and license

DeepAgent Code is licensed under **AGPL-3.0-or-later**. If you interact with a modified network service based on DeepAgent Code, the AGPL network-use clause gives you the right to receive the corresponding source code for that service.

This repository is derived from [opencode](https://github.com/sst/opencode), which is licensed under MIT. See [NOTICE](NOTICE) for the retained upstream MIT notice and attribution. No endorsement by opencode or its contributors is implied.

## Project status

V3.4.1 is the first public-release hardening milestone: license and attribution cleanup, documentation consolidation, secret-scan baseline, security disclosure, and rebrand verification before the first public tag.
