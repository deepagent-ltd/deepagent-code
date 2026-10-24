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
runtime and declaration hashes before replacing `lib/`, normalizes generated
comment whitespace, and freezes the generated copyright year. The locked
minifier retains compression with name mangling disabled because its older
scope tracker rejects the asynchronous signer code. `LICENSE` and `NOTICE` retain upstream attribution
and describe the source/generated-banner discrepancy.

Kernel reader methods are bounded and return exact decimal int64 strings.
They do not automatically publish, mark read, retry unknown effects, or fall
back to the legacy body-bearing APIs. DAC owns synchronization, current
permission checks, local projection and user initiated read actions.

Device-enabled connections use `dac-im-device-v1`. The trusted host supplies
public device metadata, a fixed socket audience and narrow signing callbacks;
the SDK never receives a private key. The first Connect requests a challenge,
and the second Connect supplies its proof on the same original socket. A
challenge ACK does not enable queries or mark the client online. Each reconnect
requires a new proof, and callbacks from a disconnected source are discarded.
Navigator and media requests use host-provided DPoP headers with current-source
checks and bounded cancellation. Connect logs contain command metadata instead
of tokens, challenges or proofs.
