<p align="center">
  <picture>
    <source srcset="assets/logo-dark.svg" media="(prefers-color-scheme: dark)">
    <source srcset="assets/logo-light.svg" media="(prefers-color-scheme: light)">
    <img src="assets/logo-light.svg" alt="DeepAgent Code logo" width="520">
  </picture>
</p>

<p align="center"><strong>An AI coding workspace for work that takes more than one prompt</strong></p>

<p align="center">Code, project memory, long-running tasks, browser work, and personal agent messaging — in one workspace.</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="https://github.com/deepagent-ltd/deepagent-code/releases">Downloads</a> |
  <a href="CHANGELOG.md">What's new</a>
</p>

---

**DeepAgent Code (DAC)** combines a desktop coding workspace and a terminal agent with a shared execution core. It helps you work through changes that span files, model turns, tools, and people: keep project context, maintain an editable plan, delegate independent tasks, inspect execution, and bring the final answer back to the conversation that started the work.

This source line targets **2.0.5**. See [GitHub Releases](https://github.com/deepagent-ltd/deepagent-code/releases) for available installation packages.

## Why DeepAgent Code

| What you need                         | How DAC helps                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Keep a complex task moving**        | Persistent sessions, editable goals and plans, live steering, and queued instructions keep work organized across many turns.                                 |
| **Stop repeating project context**    | Inspectable project memory connects facts, decisions, skills, and execution evidence, with provenance and controlled admission into model context.           |
| **Split work without losing control** | Subagents handle independent tasks with durable run records and isolated worktrees for write-capable collaboration.                                          |
| **Move between code and the web**     | A Desktop-managed browser brings page inspection and authorized interaction into the same task, including controlled file exchange.                          |
| **Turn a discussion into real work**  | Public IM supports `/dac` commands to your own local DAC, continuous follow-up in the same Session, and final answers returned to the original conversation. |
| **Choose your tools and models**      | GUI and TUI share the core; configurable providers, Skills, domain packs, and MCP extend it for your project.                                                |

## 2.0.5 highlights

**More consistent model setup.** Model lists refresh after provider connection changes, and reasoning controls follow the selected model's supported options.

**Clearer MCP management.** Add and configure servers, connect or disconnect services, and inspect their current connection status and errors.

**More control during long tasks.** Edit Goal plans, choose context-compaction modes, and take over the managed browser when a step needs your input. Browser actions remain subject to the current host's capabilities and permissions.

**Device-bound IM access.** Inspect the current device's IM entitlement, plan, and validity in Settings. IM activation remains separate from connecting a model provider.

**Windows installer fixes.** Improve user installation-path handling and PATH restoration during upgrades and uninstall.

See the [changelog](CHANGELOG.md) for published release details.

## Built for sustained work

### Sessions that preserve intent

Session inputs are persisted before execution is scheduled. While DAC works, send guidance to steer it at the next safe provider-turn boundary, or queue a separate task to begin after the active task settles. Goals add an editable plan and recorded progress to longer jobs.

Persistence also makes uncertainty visible. After an interruption, DAC distinguishes recorded work from external operations whose outcome needs recovery; it does not assume an uncertain tool or provider call is safe to repeat.

### Memory and context you can inspect

Project knowledge carries types, scope, status, versions, and source references. Saved decisions and approved experience can be reused in later sessions; you can inspect and revise them rather than relying on hidden prompt history.

Context is assembled within a budget. Code references, project memory, execution documents, Skills, and domain knowledge are admitted as needed. Stable instructions and changing task state are kept separate to support provider caching, without making a fixed token-saving promise.

### Collaboration with explicit ownership

Delegate independent research, implementation, and review tasks to subagents. Durable task records preserve ownership, status, results, and parent notifications; write-capable collaboration uses isolated worktrees and review boundaries.

The event workflow layer adds dependency-aware coordination for configured automation. It complements interactive model execution with durable delivery and observable work state.

### Native coding tools and an extensible ecosystem

DAC combines file editing, terminal commands, LSP-backed code navigation, a managed browser, and project knowledge. Skills express repeatable procedures; domain packs add specialist knowledge; MCP connects external tools and resources through the same permission-aware workflow.

Choose an official provider or configure a compatible endpoint. Model and tool support depends on the selected provider's capabilities, and IM can use a separately selected model from your local configuration.

## Use your agent from IM

For example, while discussing a bug with a teammate:

```text
/dac Inspect the login handler in this project, fix the failing case,
     and run the relevant tests.
```

DAC opens or reuses the local Session associated with that conversation. View the streaming execution in the normal DAC workspace, then receive the final answer in the IM thread. Continue with another `/dac` request to build on the same Session; you can explicitly start a new Session when you want separate context.

IM requires a separate entitlement bound to one device. DAC supports one-year, three-year, and lifetime plans without automatic renewal. Obtain activation credentials through your administrator or an authorized distribution channel. In Settings, check this device, review its access information, and redeem an activation code or bind existing access. Purchase availability, current access, and expiry are determined by the configured IM service; an unknown expiry does not mean lifetime access. Connecting a model provider does not purchase or activate IM. IM files and images have a **maximum of 10 MiB per attachment**.

Public IM transports messages; your agent executes on your own machine. DAC 2.0.5 does not provide a public remote-execution relay, shared agents callable by other users, or whole-desktop Computer Use.

## Get started

### Desktop

Download the package for your platform from [GitHub Releases](https://github.com/deepagent-ltd/deepagent-code/releases). Open DAC, connect a model provider in Settings, choose a project, and start a conversation.

### Build from source

Use the Bun version pinned in the root `package.json`: **Bun 1.4.2** for this source line.

```bash
git clone --branch 2.0.5 --single-branch https://github.com/deepagent-ltd/deepagent-code.git
cd deepagent-code
bun install
```

From the repository root:

```bash
# Desktop workspace
bun run dev:desktop

# Terminal interface
bun run dev

# Web UI development server
bun run dev:web
```

Run a one-shot task or inspect an import before writing history:

```bash
bun run --cwd packages/deepagent-code dev run "Find and fix the failing login test"
bun run --cwd packages/deepagent-code dev import-history --from codex --dry-run
```

The standalone web UI needs a running DAC backend; the web UI guide shows the two-server setup.

See the [Desktop package guide](packages/desktop/README.md), [web UI guide](packages/app/README.md), and [CLI/server guide](packages/deepagent-code/README.md) for package-specific development and build commands.

### Connect a model

In **Settings → Providers**, connect an available provider or add a compatible endpoint with its base URL and API key. Select the model and reasoning level for the task. The [DeepAgent API Platform](https://api.deepagent.ltd/) is one supported option; you can also bring your own provider credentials.

For the installed terminal application:

```bash
deepagent auth login
deepagent auth list
deepagent-code
```

On macOS and Linux, configuration and local state live under `~/.deepagent/code/`. On Windows, configuration lives under `%APPDATA%\deepagent-code` and data under `%LOCALAPPDATA%\deepagent-code`. Provider credentials follow their configured authentication path. MCP secret handles can use native credential storage where available; credentials, tool permissions, and outbound actions retain their own execution boundaries.

## Documentation and contribution

- [Architecture overview](design/README.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Privacy policy](PRIVACY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Public documentation source](packages/web/src/content/docs)

## License and attribution

DeepAgent Code is licensed under **AGPL-3.0-or-later**. See [LICENSE](LICENSE) for the full terms.

DAC builds on [opencode](https://github.com/sst/opencode) and other open-source components. Original license notices and attribution are retained in [NOTICE](NOTICE) and the relevant packages. No endorsement by upstream projects or their contributors is implied.

<p align="center"><sub>Built by DeepAgent</sub></p>
