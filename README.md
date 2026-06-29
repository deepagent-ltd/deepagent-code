<p align="center">
  <a href="https://deepagent-code.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="DeepAgent Code logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent.</p>
<p align="center">
  <a href="https://deepagent-code.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/deepagent-code"><img alt="npm" src="https://img.shields.io/npm/v/deepagent-code?style=flat-square" /></a>
  <a href="https://github.com/lessweb/deepagent-code/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/lessweb/deepagent-code/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![DeepAgent Code Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://deepagent-code.ai)

---

### What is DeepAgent Code?

DeepAgent Code is a document-centered AI coding agent. It keeps the opencode runtime, tool, MCP, session, and provider foundations, then adds the DeepAgent control plane for document memory, context assembly, retrieval gates, learning, and domain adapters.

The core design is simple: the document system is the agent's durable body. Knowledge, strategy, methodology, skill, memory, diagnosis, decisions, worklogs, and context snapshots are typed documents. The context system is the bandwidth manager that selects the smallest useful slice of those documents for each provider turn, then writes new evidence back into the document graph.

DeepAgent Code is not a rewrite of opencode. The default opencode loop remains the `general` strength. DeepAgent adds stronger modes on top of that loop without rewriting the underlying runtime.

### DeepAgent Additions

- **Document System**: a single typed-document graph for run state and durable knowledge, with versioning, provenance, links, snapshots, promotion gates, and reviewable evidence.
- **Context System**: deterministic context admission at safe provider-turn boundaries, with baseline system context, context epochs, snapshots, bounded tool output, and progressive disclosure.
- **Work strength modes**: `general`, `high`, `xhigh`, `max`, and `ultra` form a strict capability ladder. Higher modes add capabilities without silently changing the lower-mode contract.
- **Scenario modes**: `direct` preserves the user's prompt for immediate execution; `wish` first refines and confirms the task prompt before stronger automation.
- **Retrieval and anti-misleading gates**: durable knowledge is advisory, top-k bounded, evidence-gated, conflict-aware, snapshot-locked, and guarded by regression checks.
- **Domain Adapter Packs**: domain packs are DocumentStore views plus detectors, indexes, skills, validation, diagnosis, and policy profiles. They do not own a separate agent loop.
- **Learning lifecycle**: completed work can produce candidate memories, skills, facts, failure dossiers, strategies, and methodologies. Promotion is controlled by evidence, sensitivity, approval status, and review policy.

### Work Strengths

| Strength | Contract |
| --- | --- |
| `general` | opencode-inherited capability with the lightest DeepAgent control plane |
| `high` | adds DeepAgent context control, automatic micro-rounds, skills, validation, diagnosis, and project context memory |
| `xhigh` | adds domain knowledge and cross-project factual memory |
| `max` | adds strategies and methodologies under retrieval gates |
| `ultra` | adds autonomous workspace and macro-round execution; intended for confirmed `wish` tasks with stricter progress, budget, and escalation gates |

### Installation

```bash
# YOLO
curl -fsSL https://deepagent-code.ai/install | bash

# Package managers
npm i -g deepagent-code@latest        # or bun/pnpm/yarn
scoop install deepagent-code             # Windows
choco install deepagent-code             # Windows
brew install anomalyco/tap/deepagent-code # macOS and Linux (recommended, always up to date)
brew install deepagent-code              # macOS and Linux (official brew formula, updated less)
sudo pacman -S deepagent-code            # Arch Linux (Stable)
paru -S deepagent-code-bin               # Arch Linux (Latest from AUR)
mise use -g deepagent-code               # Any OS
nix run nixpkgs#deepagent-code           # or github:lessweb/deepagent-code for latest dev branch
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Desktop App (BETA)

DeepAgent Code is also available as a desktop application. Download directly from the [releases page](https://github.com/lessweb/deepagent-code/releases) or [deepagent-code.ai/download](https://deepagent-code.ai/download).

| Platform              | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `deepagent-code-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `deepagent-code-desktop-mac-x64.dmg`     |
| Windows               | `deepagent-code-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, or `.AppImage`     |

```bash
# macOS (Homebrew)
brew install --cask deepagent-code-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/deepagent-code-desktop
```

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$DEEPAGENT_CODE_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if it exists or can be created)
4. `$HOME/.deepagent-code/bin` - Default fallback

```bash
# Examples
DEEPAGENT_CODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://deepagent-code.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://deepagent-code.ai/install | bash
```

### Modes and Domain Packs

DeepAgent Code separates the user's scenario from the agent strength:

- `direct` keeps the original prompt and runs immediately.
- `wish` refines the task prompt first, then runs the confirmed work package.
- `general`, `high`, `xhigh`, `max`, and `ultra` control how much DeepAgent machinery may participate.

Domain packs can be activated automatically from the problem profile or selected explicitly. They expose refs, summaries, skills, validation adapters, diagnosis signals, and policy profiles; the context and retrieval gates decide what is allowed into the model context.

Learn more in the design docs under [`docs/`](./docs/README.md).

### Documentation

For more info on how to configure DeepAgent Code, [**head over to our docs**](https://deepagent-code.ai/docs).

### Contributing

If you're interested in contributing to DeepAgent Code, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on DeepAgent Code

If you are working on a project that's related to DeepAgent Code and is using "deepagent-code" as part of its name, for example "deepagent-code-dashboard" or "deepagent-code-mobile", please add a note to your README to clarify that it is not built by the DeepAgent Code team and is not affiliated with us in any way.

---

**Join our community** [Discord](https://discord.gg/deepagent-code) | [X.com](https://x.com/deepagent-code)
