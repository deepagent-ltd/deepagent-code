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
  <a href="README.zh.md">简体中文</a> |
  <a href="https://github.com/deepagent-ltd/deepagent-code-enterprise">Enterprise</a>
</p>

<p align="center"><sub>Desktop v1.3</sub></p>

---

DeepAgent Code is an AI coding agent built on persistent document memory. It keeps [opencode](https://github.com/sst/opencode)'s runtime foundations and adds a control plane so the agent behaves less like a one-shot chat and more like a teammate that remembers your project, sharpens vague asks, and goes deep on hard problems.

The features below start from a real need — something a plain coding agent, opencode included, leaves on the table — and work down to the architecture we built to serve it.

## What You Can Do

### Bring your history over — switch tools without starting from zero

**The need:** You've built up months of context in another agent — Codex or Claude Code — and switching tools normally means abandoning all of it: the conversations, the accumulated memory, the skills you tuned. That cost alone keeps people on tools they've outgrown.

**What DeepAgent does:** One-click import of your existing history. Point it at a Codex or Claude Code installation and it hot-imports your chat sessions, memory, and skills straight into DeepAgent — reading each tool's on-disk format, normalizing it, and replaying it into the document graph so imported conversations behave like native ones. Secrets are redacted on the way in, imported projects stay isolated so nothing collides with your active work, and re-running an import converges instead of duplicating. Available from the Settings "Import history" panel, a History view in the sidebar, or the `import-history` CLI command. Migration is a few minutes, not a fresh start.

### Keep one conversation going indefinitely

**The need:** Long tasks overflow the context window. Most agents respond by truncating history or summarizing everything at a threshold — so mid-task the agent forgets a decision you made an hour ago, or the window fills with stale tool output and quality falls off a cliff.

**What DeepAgent does:** Your conversation is treated as a continuously maintained work state, not a growing chat log. Before every turn, the agent rebuilds a working set — the task anchor, the most recent exchanges verbatim, active file references, and only the older facts that are relevant right now — while the full history is archived durably and stays queryable. The working set is held to a hard fraction of the model window, so there's always room for the model to actually think and respond. You just keep talking; the agent keeps focus.

### Switch windows, fork freely, never lose memory

**The need:** You want to try two approaches, or hand the work to a fresh conversation, without starting from amnesia and without polluting the original thread.

**What DeepAgent does:** Fork any conversation from a chosen message. The fork opens carrying the parent's memory up to that point, shows a full-width "derived from" marker at the top of its transcript, and nests folder-style under its origin in the session tree (subagents and forks alike, up to three levels deep). Knowledge flows up a scope hierarchy — what one session learns can be promoted to the whole project, and cross-project preferences live at the user-global layer — so switching windows is a clean handoff, not a reset.

### Ask roughly, and let the agent sharpen it

**The need:** A half-formed prompt gets a half-useful answer, and you don't always know how to phrase what you want.

**What DeepAgent does:** Two scenario modes on the composer. **Direct** sends your prompt as-is — you own the wording. **Intelligence** refines a rough ask into a sharper prompt, surfaces a draft plan and decision suggestions, and waits for your confirmation before it automates anything. You decide how much the agent shapes the request.

### Choose how much the agent drives — and who writes the plan

**The need:** Sometimes you want the agent to just take a request and run; sometimes you want to steer it with a plan you control; sometimes you've already written the plan and just want it executed faithfully.

**What DeepAgent does:** Three collaboration modes on the composer, picked from a single selector. **Auto** — the agent sets the objective, designs and plans as needed, and executes to completion. **Loop** — you describe the goal, the agent writes a `goal+plan.md` you can edit, then a supervised loop drives it to completion (plan → execute → verify per tick, with hard budget/step ceilings and objective completion checks). **Design** — you author `goal+plan.md` yourself and the agent executes your plan faithfully without redefining the goal. Orthogonal to mode, a permission control offers three presets — **Read-only**, **Request approval** (default), **Full access** — so autonomy and approval are separate, explicit choices.

### Get a second opinion before high-risk decisions

**The need:** Some decisions — a breaking migration, a security-sensitive change, an architecture call — deserve more than one confident pass agreeing with itself.

**What DeepAgent does:** Convene an **Expert Panel** from the composer. Differentiated expert lenses (correctness, security, performance, architecture, repro) review the same frozen question independently, debate anonymously, and a deterministic (non-LLM) arbiter aggregates a verdict — with minority opinions preserved and a fail-closed bias toward escalating to you when the panel can't safely agree.

### Read and govern what the agent knows

**The need:** Persistent memory is only trustworthy if you can see it and correct it.

**What DeepAgent does:** A **Repo & Wiki** view projects the four graphs into human-readable pages — browse and full-text-search the agent's knowledge, follow docs↔code cross-links, and edit governable Knowledge/Memory pages through the same evidence-gate the agent uses (Documents and Code stay read-only). A separate governance view lists learned facts grouped by project and global scope, so you approve what becomes durable.

### Go deep on genuinely hard problems

**The need:** Complex work — an architecture decision, a tricky migration, a subtle bug — needs more than a single confident pass. It needs research, a second opinion, and someone actively trying to poke holes.

**What DeepAgent does:** At higher work strengths the primary agent decomposes the task, fans it out to focused subagents that research modules in parallel, synthesizes their findings, and then runs independent reviewers whose job is to *break* the plan rather than agree with it. Fan-out is bounded by a configurable concurrency ceiling, and live subagents surface in a session side panel and inline in the transcript so you can watch and jump into any of them.

### Chat with your team and your agents in one place

**The need:** Coordinating with teammates and driving agents usually happens in two different tools.

**What DeepAgent does:** A per-project group chat lives in the session side panel. @mention an agent as a chat member and it runs the full agent loop — query code, generate, fix — pulling project knowledge and recent messages for context, then replies inline with live progress streaming.

## How It Works

Each capability above is served by a control-plane primitive underneath. These are the parts a plain runtime doesn't have.

**Four-graph unification** — Code, knowledge, project memory, and the document graph are unified into one typed, bidirectionally-linked store. When the agent pulls context, a change to a symbol surfaces the design decisions, past diagnoses, and knowledge actually linked to it — connected context, not four disconnected keyword searches.

**Domain packs** — 140+ composable knowledge packages spanning languages, frameworks, platforms (cloud, Kubernetes, CI), hardware, and business/risk domains (security, privacy, compliance). Each pack bundles typed documents (strategies, methodologies, knowledge, skills, failure dossiers) with detectors that auto-activate the right packs for your task; conflicts resolve stricter-policy-wins, and the active set is version-locked so a run is reproducible. Core stays domain-neutral — expertise is data on disk, not hardcoded.

**Tiered knowledge invocation** — A monotonic strength ladder (`general → high → xhigh → max → ultra`) gates how much control-plane machinery engages. `general` stays close to the plain runtime — fast and cheap. Higher rungs progressively unlock durable knowledge, project handoff summaries, heavier strategy/methodology tiers, and multi-agent orchestration. You pay for depth only when you dial it up.

**Self-learning** — After work lands, the agent proposes candidate knowledge, facts, and methodologies. Promotion is evidence-gated (a test passed, a diagnostic cleared, a validation confirmed) and user-controllable — durable knowledge is carried over deliberately, not silently guessed. Session-stable conclusions consolidate into project memory over time, so the next session starts smarter about *your* codebase.

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
3. Activate the relevant domain packs (backend API, the project's language)
4. Implement rate limiting following project conventions
5. Run tests, capture diagnostics, and propose a candidate memory: "This project uses express-rate-limit middleware"

On your next session, when you ask to add rate limiting elsewhere, the agent already knows the pattern.

## Core Concepts

**Document graph** — All persistent state lives in typed documents: `knowledge`, `strategy`, `methodology`, `skill`, `memory`, `design`, `worklog`, `diagnosis`, `eval`. Documents link to each other (supports/blocks/conflicts/validates), forming a graph you can traverse.

**Scope layers** — `session-private` (current conversation), `project-shared` (all sessions in this project), `user-global` (cross-project preferences), `public-system` (built-in skills), `sealed` (audit-only, never enters context).

**Context admission** — Retrieval hits pass through admission gates. Full tool output (raw LSP dumps, diagnostics, capability indexes) is written to evidence artifacts, ref-linked and tool-only; only summaries and `file:line` snippets enter the model context. Sensitive values (SSH hosts, tokens, internal paths) are suggested, never auto-expanded.

**AI IDE microservice** — Query code by symbol name and intent (e.g. `code_intel({ symbol: "AgentGateway.open", intent: "overview" })`), not file:line coordinates. Get definitions, references, call chains, type hierarchies, and diagnostics in one call. Built on LSP with 38 language servers; degrades gracefully to grep/read when no server is configured.

**Preset MCP catalog** — Curated MCP servers for Git platforms, file search, read-only databases, and browser automation. Risk tiers are derived at load time from the catalog template (not user config, so they can't be injected), and servers default to not-connected with write and external-fetch operations behind approval gates.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Control Plane (DeepAgent additions)                        │
│  • Four-graph unified store (code + knowledge + memory + doc)│
│  • Continuously maintained working state (memory + compaction)│
│  • Domain pack system (composable, auto-activating knowledge)│
│  • Context assembly & admission gates                       │
│  • Multi-agent orchestration & adversarial review           │
│  • Evidence-gated learning & work-strength ladder           │
└─────────────────────────────────────────────────────────────┘
                             │
┌─────────────────────────────────────────────────────────────┐
│  Runtime Foundations (from opencode)                        │
│  • Agent loop & tool execution                              │
│  • Session, fork & provider management                      │
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

DeepAgent's control plane operates at provider-turn boundaries: it selects context before each model call and writes evidence back into the document graph afterward. It does not replace opencode's runtime — it layers on top.

## Documentation

- [Architecture & Design](design/README.md) — Control plane, code intelligence, MCP security model
- [Security Policy](SECURITY.md) — Vulnerability reporting, known limitations
- [Privacy Policy](PRIVACY.md) — Data handling and storage
- [Contributing](CONTRIBUTING.md) — Development setup and guidelines
- [Changelog](CHANGELOG.md) — Release history

## License & Attribution

DeepAgent Code is licensed under **AGPL-3.0-or-later**. If you modify and run it as a network service, you must make your source code available to users.

This project is derived from [opencode](https://github.com/sst/opencode) (MIT License). See [NOTICE](NOTICE) for the upstream license and attribution. No endorsement by opencode or its contributors is implied.

---

<p align="center">
  <sub>Built by DeepAgent</sub>
</p>
