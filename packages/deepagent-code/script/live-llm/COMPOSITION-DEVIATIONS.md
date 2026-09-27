# Live harness composition deviations (G3)

`runLegacyLiveCases` records its live `CompositionDigest.current`, builds a scoped production
`AppLayer` digest under the same isolated test home, and compares every facet through
`assertHarnessComposition`. The allowlist is machine-readable in
`COMPOSITION-DEVIATIONS.json`; a new difference fails the gate until both that file and the
reviewed path pin in `composition-gate.ts` change. The harness deliberately differs in:

| Facet | Harness value | Reason and check |
| --- | --- | --- |
| `locationHost.host`, `locationHost.seams` | `liveFrameIdentity` in `runner-frame.ts` | The isolated harness supplies a real context-tool facade and query-authorization store, but no IM delivery, production context-source adapters, settle callback, or settle gate. G3 checks this exact declaration instead of using the unqualified Core fallback. |
| `v2Registry.applicationTools` | Host `debug`, `profile`, and `query_log` plus fixture-specific process tools | The host tools retain their app-owned runtime flags and services; the tool-ecosystem fixture also loads `live_custom`. G3 requires their exact IDs, valid digest, zero rejected names, and V2 materialization. |
| `v2Registry.materialized` | Production built-ins plus host and fixture process tools | The host and fixture can add tools to the effective Core registry. G3 checks its count, effect-kind partition, and each declared ID. |
| `v2Registry.legacyEgress` | Fixture V1 tool inventory | Fixture and production instances load different egress definitions. The Core V2 materialized registry is still checked separately. |

The scoped `AppLayer` build is disposed before the temporary home is removed, so it does not
reuse the process-global embedded runtime between live suites. G3 compares actual root facts
and still verifies the fixture tool inventory and digest recomputation.
