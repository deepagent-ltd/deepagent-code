# DAC IM kernel SDK

This private workspace package contains the reviewed JuggleIM SDK source and
the exact runtime/declarations validated against the protected reader kernel.
Import its default export from `@deepagent-code/im-kernel-sdk`. DAC's trusted
factory always initializes it with `protectedDeliveryReader: true`.

The original source and locked build tools live in `upstream/`. To reproduce:

```sh
npm ci --ignore-scripts --prefix upstream
bun run build
```

The build uses the original protobuf and Rollup pipelines, verifies the pinned
runtime and declaration hashes before replacing `lib/`, and freezes only the
generated copyright year. `LICENSE` and `NOTICE` retain upstream attribution
and describe the source/generated-banner discrepancy.

Kernel reader methods are bounded and return exact decimal int64 strings.
They do not automatically publish, mark read, retry unknown effects, or fall
back to the legacy body-bearing APIs. DAC owns synchronization, current
permission checks, local projection and user initiated read actions.
