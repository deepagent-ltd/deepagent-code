<p align="center">
  <picture>
    <source srcset="assets/logo-dark.svg" media="(prefers-color-scheme: dark)">
    <source srcset="assets/logo-light.svg" media="(prefers-color-scheme: light)">
    <img src="assets/logo-light.svg" alt="DeepAgent Code logo" width="520">
  </picture>
</p>

<p align="center"><strong>The AI coding agent that remembers, plans, collaborates, and finishes</strong></p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">中文</a> |
  <a href="https://github.com/deepagent-ltd/deepagent-code-enterprise">Enterprise</a>
</p>

---

DeepAgent Code is an AI coding workspace for work that lasts longer than one prompt. You can ask for a small edit, guide a running task without interrupting it, hand over a migration with objective completion criteria, or bring several specialist agents into a decision — and the work stays coherent across turns, restarts, tools, people, and projects.

## What makes it different

| A typical coding agent | DeepAgent Code |
|---|---|
| Understands only what's in the current prompt | **Remembers your project** — sessions survive restarts, and what you taught it is still there tomorrow |
| Searches for files when it needs context | **Understands the project** — code, knowledge, project memory and documents are connected, so it works from what your project actually is |
| Does one task at a time | **Plans and finishes real work** — define a goal once, and it advances through plan → execute → verify → iterate |
| Works alone | **Collaborates with specialists** — bounded subagents, worktree isolation, and an Expert Panel for high-risk decisions |
| Runs only in one place, one model | **Fits your setup** — desktop or terminal, and 75+ model providers with your own API keys |
| Keeps its memory a black box | **Memory you can see and govern** — inspect what it learned, reject what it shouldn't repeat |

Everything below is what this means day to day.

## One Workspace, Three Ways to Work

Choose the collaboration style that fits the task:

| Mode | You provide | DeepAgent does |
|---|---|---|
| **Auto** | A request | Defines the objective, designs and plans as needed, then executes end to end |
| **Loop** | A goal | Writes an editable `goal+plan.md` and advances it through plan, execute, verify, and iterate ticks |
| **Design** | Your `goal+plan.md` | Executes your design faithfully without redefining its objective or completion criteria |

Autonomy and permission are independent. Use **Read-only**, **Request approval**, or **Full access** without changing the collaboration mode.

## Stay in Control While It Works

DeepAgent is built for active collaboration, not fire-and-forget automation.

- **Live steering:** send new guidance while a model turn or tool is running. The message is durably admitted and absorbed at the next safe provider-turn boundary without aborting in-flight work.
- **Goal steering:** guidance sent to an active goal is folded into the next tick, preserving the current tool and plan state.
- **Hot plan editing:** edit a running or paused goal. Stable step IDs, evidence, completed work, and the new plan version carry into the next tick.
- **Explicit queueing:** queue a future activity when the instruction should begin after the current activity instead of changing it.
- **Pause, resume, take over, or roll back:** every long-running workflow has a human control path and a durable audit trail.

## Memory You Can Inspect and Govern

DeepAgent does not hide memory in an opaque prompt. Project state lives in typed, versioned documents with provenance, confidence, scope, status, and links.

- Session-private working context stays with the current conversation.
- Project-shared facts and decisions follow the repository.
- User-global preferences can travel across projects.
- Built-in skills and domain packs remain versioned system knowledge.
- Sealed evaluator material stays audit-only and never enters model context.

Learning follows a governed lifecycle: evidence creates a candidate, isolated review or a human decision changes its status, and regression/ablation gates publish a reproducible knowledge snapshot. Rejection reasons remain durable so discarded patterns are not silently relearned.

The **Repo & Wiki** view makes this system readable. Browse knowledge and execution archives, search across the repository, follow docs-to-code links, inspect lineage, and promote useful run evidence into governed knowledge.

## Connected Context, Not a Larger Prompt

DeepAgent connects four views of the project:

1. **Code graph:** files, symbols, imports, calls, diagnostics, and references.
2. **Knowledge graph:** strategies, methodologies, facts, skills, and failure dossiers.
3. **Project memory:** decisions, constraints, environment facts, and learned conventions.
4. **Document graph:** plans, designs, worklogs, evaluations, run context, and evidence.

The Session V2 runner assembles context from explicit sources under a durable Context Epoch. It selects linked evidence within budget, records why each reference was admitted or rejected, and preserves the current goal, constraints, decisions, open questions, next steps, and relevant files during compaction.

Prompt caching remains effective across long runs: stable system instructions stay byte-stable, while plans, steering, budgets, round results, and other volatile state are appended in a dedicated tail block.

## Built for Difficult Work

### AI IDE

Query code by symbol and intent instead of guessing file locations. DeepAgent combines LSP definitions, references, call chains, type information, diagnostics, rename previews, and cross-file evidence. Unsaved editor buffers participate in LSP updates, so analysis follows the code you are actually editing.

### Domain packs

Composable domain packs add language, framework, platform, hardware, business, and risk expertise without hardcoding it into the core. Packs activate from the problem profile, resolve conflicts with stricter-policy-wins semantics, and are snapshot-locked for reproducible runs.

### Specialist agents and Expert Panel

DeepAgent can partition independent work across bounded, isolated workers. Delegated runs persist their identity, generation, owner, lease, phase, terminal state, result, and parent delivery, so an exact retry resumes the same work instead of silently starting another worker. Write-capable subagents receive dedicated worktrees, return compact summaries and artifact references, and leave their full transcripts available for inspection.

Automatic write collaboration follows a durable Git/PR path. Workers commit only their scoped changes; one Reviewer session checks each exact worker SHA, the coordinator performs serial `--no-ff` merges on the Session branch, and one Senior Reviewer examines the merged batch. Resume, timeout, cancellation, takeover, review feedback, and cleanup are generation-fenced so a stale worker cannot settle or overwrite newer work.

For high-risk decisions, convene an **Expert Panel**. Correctness, security, performance, architecture, and reproducibility lenses review the same frozen question, debate anonymously for up to three rounds, and feed a deterministic arbiter that preserves minority opinions and fails closed to human review.

### Team and agent messaging

Project IM brings people and agents into the same thread. Mention an agent to start a scoped run with project context, stream its progress, inspect its artifacts, and keep the answer attached to the conversation that requested it.

## Installation

> **Note:** The `deepagent-code` npm package is not yet publicly published.
> Install via the desktop app or the install script below.

```bash
# Install script (macOS / Linux)
curl -fsSL https://deepagent.ltd/install | bash
```

Then run:

```bash
deepagent-code
# or use the alias:
deepagent
```

## Adding a Model Provider

### DeepAgent API — our own platform (recommended)

If you want the experience DeepAgent Code is tuned around, use the official
**DeepAgent API Platform** ([api.deepagent.ltd](https://api.deepagent.ltd)) — a
secure model API service for DeepAgent applications with GPT and DeepSeek
families over Chat Completions and Responses, plus Anthropic-compatible
endpoints. Get a key from the platform console, check plan prices on
[Model Square pricing](https://api.deepagent.ltd/pricing), then open
**Settings → Providers → DeepAgent → Connect**, paste the key, and you're done.

### Any other provider

DeepAgent Code is provider-agnostic. It supports 75+ providers through the
[AI SDK](https://ai-sdk.dev/) and [models.dev](https://models.dev), plus any
OpenAI- or Anthropic-compatible endpoint.

### Desktop app (recommended)

Open **Settings → Providers**:

- **Official providers** (DeepAgent, OpenAI, Anthropic, DeepSeek, Google, xAI, ZhipuAI/GLM):
  click **Connect**, paste your API key.
- **Any other provider or gateway**: click **Connect** on *Custom provider*, paste
  the **Base URL** and **API key**. DeepAgent Code auto-detects the protocol
  (OpenAI-compatible or Anthropic) and discovers the available models from the
  endpoint's `/models` list — you don't have to fill anything else.

Model specs (context window, reasoning) are auto-filled by matching each model
against the models.dev catalog. You can reopen a custom provider to override a
model's context/reasoning/temperature; those overrides are best-effort and not
guaranteed to keep the model working.

### Terminal

```bash
# Log in to a provider (official providers, or a plugin auth flow)
deepagent auth login

# See what's connected
deepagent auth list
```

### Config file

Providers also live in `~/.deepagent/code/config.jsonc`. A custom
OpenAI-compatible endpoint looks like this — set `discovery: true` to have models
refreshed from the endpoint at runtime, or list them explicitly under `models`:

```jsonc
{
  "$schema": "https://deepagent-code.ai/config.json",
  "provider": {
    "myprovider": {
      "name": "My Provider",
      "npm": "@ai-sdk/openai-compatible",
      "discovery": true,
      "options": {
        "baseURL": "https://api.myprovider.com/v1",
        "apiKey": "sk-..."
      }
    }
  }
}
```

Official-provider keys added via the app/CLI are stored separately in
`~/.deepagent/code/auth.json`, not in the config file. Full reference
(base URL overrides, headers, per-model config, gateways) lives in the
[DeepAgent API Platform docs](https://api.deepagent.ltd/) — or explore
supported models and plans on [Model Square pricing](https://api.deepagent.ltd/pricing).

All DeepAgent Code private filesystem data lives under `~/.deepagent/code/`, including configuration, credential references, databases, Desktop state, logs, caches, and temporary files. Native secret values remain in the operating system's credential store. Tests use explicit isolated roots and cannot redirect production storage through ordinary environment variables.

## Quick Example

Start the agent and give it a task:

```bash
deepagent-code run "add rate limiting to /api/users endpoint"
```

The agent will:

1. Use LSP to find the endpoint definition and understand its structure
2. Check project memory for existing middleware patterns
3. Activate the relevant domain packs (backend API, the project's language)
4. Implement rate limiting following project conventions
5. Run tests, capture diagnostics, and propose a candidate memory: "This project uses express-rate-limit middleware"

On your next session, when you ask to add rate limiting elsewhere, the agent already knows the pattern.

## How It Works (under the hood)

**Document graph** — All persistent state lives in typed documents: `knowledge`, `strategy`, `methodology`, `skill`, `memory`, `design`, `worklog`, `diagnosis`, `eval`. Documents link to each other (supports/blocks/conflicts/validates), forming a graph you can traverse.

**Scope layers** — `session-private` (current conversation), `project-shared` (all sessions in this project), `user-global` (cross-project preferences), `public-system` (built-in skills), `sealed` (audit-only, never enters context).

**Context admission** — Retrieval hits pass through admission gates. Full tool output (raw LSP dumps, diagnostics, capability indexes) is written to evidence artifacts, ref-linked and tool-only; only summaries and `file:line` snippets enter the model context. Sensitive values (SSH hosts, tokens, internal paths) are suggested, never auto-expanded.

**AI IDE microservice** — Query code by symbol name and intent (e.g. `code_intel({ symbol: "AgentGateway.open", intent: "overview" })`), not file:line coordinates. Get definitions, references, call chains, type hierarchies, and diagnostics in one call. Built on LSP with 38+ language servers; degrades gracefully to grep/read when no server is configured.

**Preset MCP catalog** — Curated MCP servers for Git platforms, file search, read-only databases, and browser automation. Risk tiers are derived at load time from the catalog template (not user config, so they can't be injected), and servers default to not-connected with write and external-fetch operations behind approval gates.

The full architecture and its invariants are documented in [Architecture & Design](design/README.md).

## Build From Source

DeepAgent Code uses Bun 1.3.14.

```bash
git clone https://github.com/deepagent-ltd/deepagent-code.git
cd deepagent-code
bun install
```

Start the Desktop app:

```bash
bun run dev:desktop
```

Start the terminal experience:

```bash
bun run dev
```

Run a one-shot task:

```bash
bun run --cwd packages/deepagent-code dev run "add rate limiting to /api/users"
```

Import existing Codex or Claude Code history:

```bash
bun run --cwd packages/deepagent-code dev import-history --from codex --dry-run
```

## Documentation

- [DeepAgent API Platform](https://api.deepagent.ltd/) · [Model Square pricing](https://api.deepagent.ltd/pricing)
- [Architecture & Design](design/README.md)
- [Real-LLM Testing Guide](design/real-llm-testing.md)
- [Security Policy](SECURITY.md)
- [Privacy Policy](PRIVACY.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## License & Attribution

DeepAgent Code is licensed under **AGPL-3.0-or-later**. If you modify and run it as a network service, you must make the corresponding source available to its users.

DeepAgent Code is derived from [opencode](https://github.com/sst/opencode) under the MIT License. See [NOTICE](NOTICE) for upstream attribution. No endorsement by opencode or its contributors is implied.

---

<p align="center"><sub>Built by DeepAgent</sub></p>
