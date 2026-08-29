# DeepAgent Code Desktop

The DeepAgent Code Desktop app, built with Electron.

## Alpha release

The coordinated Desktop 2.0 alpha uses package version `2.0.0-alpha.0` and the release label `desktop-v2.0alpha`. It is validated alongside the Core V2 alpha; neither label promises stable API compatibility or a production database migration.

## Development

```bash
bun install
bun dev
```

## Build

Run the `build` script to build the app's JS assets, then `package` to
bundle the assets as an application. The resulting app will be in `dist/`.

```bash
bun run build && bun run package
```
