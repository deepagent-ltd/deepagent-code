// C6-08: "复制上下文" — copy/export a session's recovery context in read-only recovery. Reuses the
// generated recovery evidence-export surface (client.maintenance.recovery.* — the unified
// generated SDK nests recovery under the `maintenance` group) which remains available when the
// store is in read_only_recovery mode. Kept dependency-free so it is fixture-testable in isolation.

/** Minimal structural view of the generated maintenance/recovery surface the CLI drives. */
export type RecoveryExportClient = {
  readonly maintenance: {
    readonly recovery: {
      readonly evidenceExport: (
        parameters: { export_id: string },
        options?: { readonly throwOnError?: boolean },
      ) => Promise<unknown>
      readonly evidenceExport2: {
        readonly create: (
          parameters?: { readonly evidenceExportInput?: { readonly session_id: string } },
          options?: { readonly throwOnError?: boolean },
        ) => Promise<unknown>
      }
    }
  }
}

/** Create a new evidence export manifest for a session (default-redacted), or read a prior one by id. */
export async function exportSessionContext(
  sdk: RecoveryExportClient,
  input: { readonly sessionID: string; readonly exportID?: string },
): Promise<unknown> {
  const recovery = sdk.maintenance.recovery
  if (input.exportID) {
    // Read a previously-created evidence export manifest (a settled/expired export is a typed 410).
    return recovery.evidenceExport({ export_id: input.exportID }, { throwOnError: true })
  }
  // Create a new evidence export manifest for the session; the record remains available even when
  // the store is in read-only recovery (it is a maintenance/recovery record, not a live-store write).
  return recovery.evidenceExport2.create({ evidenceExportInput: { session_id: input.sessionID } }, { throwOnError: true })
}
