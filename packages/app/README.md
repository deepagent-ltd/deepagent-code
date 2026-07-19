# @deepagent-code/app — Desktop Application

SolidJS front-end shell for the DeepAgent Code desktop app (Electron/Tauri).

## Stack

- **UI:** SolidJS + Vite (Bun)
- **Backend:** `deepagent-code` package spawned as a local server or connected via the server-mode gateway
- **Build output:** `dist/` — consumed by the Electron/Tauri packager in CI

## Development

```bash
# from repo root
bun install
bun run dev        # hot-reload dev server
```

## Building

```bash
bun run build      # production bundle → dist/
```

Desktop releases are produced by the `desktop-build` CI workflow, which reads the version from this `package.json` and tags the release `app-v{version}-main.{run_number}`.

## Configuration

Provider credentials and agent settings live in `~/.deepagent/code/`. See the root README for the full reference.

## E2E Testing

Playwright starts the Vite dev server automatically via `webServer`, and UI tests expect an deepagent-code backend at `localhost:4096` by default.

```bash
bunx playwright install chromium
bun run test:e2e:local
bun run test:e2e:local -- --grep "settings"
```

Environment options:

- `PLAYWRIGHT_SERVER_HOST` / `PLAYWRIGHT_SERVER_PORT` (backend address, default: `localhost:4096`)
- `PLAYWRIGHT_PORT` (Vite dev server port, default: `3000`)
- `PLAYWRIGHT_BASE_URL` (override base URL, default: `http://localhost:<PLAYWRIGHT_PORT>`)

## Deployment

You can deploy the `dist` folder to any static host provider (netlify, surge, now, etc.)
