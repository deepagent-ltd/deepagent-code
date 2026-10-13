# DeepAgent Code Desktop

The Electron desktop application for DeepAgent Code. It combines the shared [GUI renderer](../app/README.md) with a local [agent server](../deepagent-code/README.md), project tools, terminals, and an integrated browser.

The current source release line and package version are **2.0.4**. The build pipeline pins the actual package version and channel. See the [repository README](../../README.md) for product features and downloads.

## Package responsibilities

- The main process owns native integration, local server lifecycle, application windows, and browser hosting.
- The preload exposes the desktop API to the renderer.
- The shared GUI renders sessions, streaming responses, project tools, and IM. Agent execution remains in the local server.

Browser automation capabilities depend on the host platform, runtime, and available permissions. The integrated browser is not a general desktop computer-use service.

## Development

Use the Bun version declared in the root `package.json`. Run from the repository root:

```bash
bun install
bun run dev:desktop
```

This runs the desktop `predev` preparation and Electron Vite development server. Root `bun dev` starts the terminal interface instead. For browser-based GUI development without Electron, use the [app package instructions](../app/README.md).

## Build and package

Run these commands from `packages/desktop`:

```bash
bun run build
```

The build prepares the local server and native assets, bundles the Electron main/preload/renderer code into `out/`, and audits the server bundle. To package an already prepared build, select the current host's target:

```bash
bun run package:mac
# or: bun run package:win
# or: bun run package:linux
```

Installer output goes to `dist/`. These commands require the appropriate native build tools and packaging configuration. macOS packaging requires signing configuration by default; `DEEPAGENT_CODE_ALLOW_UNSIGNED=1` explicitly selects an unsigned test candidate. It does not bypass Native asset validation.

For a complete macOS Native package, `bun run package:complete:mac` carries one configured Native publisher through preparation, compilation, and packaging on the target architecture's native host. It requires a matching Native publisher key and public pin, a release identity, and the selected asset signing identity.

The `publish` and `desktop-build` GitHub Actions workflows share the [desktop packaging action](../../.github/actions/package-desktop/action.yml). It sets the build identity, prepares the Native publisher, builds and packages, verifies the packaged Native assets, and cleans up the temporary publisher. Use this workflow for release packages rather than treating a successful JavaScript bundle as a completed installer.

## Validate changes

From `packages/desktop`:

```bash
bun typecheck
bun test src/path/to/affected.test.ts
```

Native and packaged-runtime checks are separate from unit tests. Select the checks for the platform and packaging path being changed.
