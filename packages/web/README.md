# @deepagent-code/web — Documentation Site

Astro + Starlight documentation site for DeepAgent Code.

## Development

```bash
# from repo root
bun install
bun run dev          # starts Astro dev server at localhost:4321
```

Or from this directory:

```bash
bun run dev
bun run build        # production build → dist/
bun run preview      # preview production build locally
```

## Structure

```
src/
  content/
    docs/            # .md / .mdx pages — each file is a route
  assets/            # images referenced in docs
public/              # static assets (favicons, etc.)
astro.config.mjs
```

## Deployment

The `dist/` output is a static site deployable to any static host.
