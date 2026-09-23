# Live harness composition deviations (G3)

`runLegacyLiveCases` records its live `CompositionDigest.current` and checks it through
`assertHarnessComposition`. The check uses the production `V2RunnerFrame` session-owner
identity and authority-surface declaration. The harness deliberately differs from the
production root in these facets:

| Facet | Harness value | Reason and check |
| --- | --- | --- |
| `locationHost.host`, `locationHost.seams` | `liveFrameIdentity` in `runner-frame.ts` | The isolated harness supplies a real context-tool facade and query-authorization store, but no IM delivery, production context-source adapters, settle callback, or settle gate. G3 checks this exact declaration instead of using the unqualified Core fallback. |
| `v2Registry.applicationTools` | Fixture-specific process tools | The tool-ecosystem fixture loads `live_custom`; G3 requires its exact ID, valid digest, zero rejected names, and V2 materialization. Suites without fixtures require an empty application set. |
| `v2Registry.materialized` | Production built-ins plus fixture process tools | The fixture can add tools to the effective Core registry. G3 checks its count, effect-kind partition, and each declared fixture ID. |

The database is the harness's isolated test database; it is not compared to a separately
booted `AppRuntime` because that global runtime would outlive the temporary home between
live suites. The digest is recomputed from every observed facet. This gate verifies the
tool bridge and declared frame during live execution; it does not claim byte-for-byte
equality of two roots with different fixture workspaces.
