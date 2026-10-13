# DeepAgent Code CLI and Server

This package provides the agent runtime behind DeepAgent Code's terminal interface, web interface, and Electron desktop app. It brings durable sessions, streaming model output, tools, permissions, context management, and agent coordination into one execution path.

The current source release line and package version are **2.0.4**. Release builds use the version selected by the build pipeline; development builds may use a preview identifier. See the [repository README](../../README.md) for product features, installation, and release downloads.

## One runtime, several interfaces

- **TUI:** run the agent directly in a terminal.
- **Server:** expose the same runtime through HTTP and streaming events for GUI clients and the JavaScript SDK.
- **Desktop:** the Electron app starts a local server and uses the shared GUI renderer.
- **IM:** `/dac` invokes the user's local DAC agent, reuses the conversation's session for follow-up requests, and returns the final answer to the conversation. IM activation is separate from model configuration.

The runtime builds on OpenCode and adds persistent task state, event-driven work coordination, document-based context, and domain packs. Tools, MCP integrations, and domain packs extend the existing agent runtime.

## Development

Use the Bun version declared in the root `package.json`. From the repository root:

```bash
bun install
bun dev
```

`bun dev` starts the TUI. To start only the local backend for a GUI development server:

```bash
bun run dev serve --port 4096
```

The desktop and web development commands are `bun run dev:desktop` and `bun run dev:web`, respectively. They are separate root scripts.

## Installed commands

The package declares both `deepagent-code` and `deepagent` command names:

```bash
deepagent-code
deepagent-code serve --port 4096
```

Use the [release downloads](https://github.com/deepagent-ltd/deepagent-code/releases) for distributed binaries. This source package is marked `private`; its manifest alone does not indicate an npm release.

## Build and validate

From the repository root, build a binary for the current platform and architecture:

```bash
bun run --cwd packages/deepagent-code build --single
```

The default output directory is `packages/deepagent-code/dist/`. The build includes the web UI unless explicitly disabled. Native helper compilation requires the target's build tools; a cross-compiled JavaScript executable alone is not a complete platform package.

Run checks from this package directory:

```bash
cd packages/deepagent-code
bun typecheck
bun test test/path/to/affected.test.ts
```

For all registered workspace tests, use `bun run test` from the repository root. Bare `bun test` at the root is intentionally guarded. Desktop packaging is described in the [desktop package README](../desktop/README.md).
