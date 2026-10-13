# Documentation scaffold

This directory contains a Mintlify documentation scaffold. Its example pages and hosted OpenAPI URL are not a complete guide to the current DAC release.

For the **2.0.4** product introduction and current development commands, use the [repository README](../../README.md). The public documentation site's source lives in [packages/web](../web/src/content/docs), and the generated API contract is [packages/sdk/openapi.json](../sdk/openapi.json).

## Local preview

To work on this scaffold, run the Mintlify CLI from this directory:

```bash
mint dev
```

The navigation and hosted API reference are configured in `docs.json`. Deployment of this scaffold requires its own Mintlify configuration; changing it does not publish the DAC application or replace the main documentation site.
