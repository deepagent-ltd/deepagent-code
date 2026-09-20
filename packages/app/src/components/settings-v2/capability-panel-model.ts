import type { CapabilityCatalog, CapabilityLoadReceipts, SystemContextSnapshot } from "@deepagent-code/sdk/client"

// C6-09 — capability panel view model. Pure derivation from the three endpoint payloads
// (/capability/catalog, /capability/loadReceipts, /system-context/snapshot) into the flat
// row shapes the panel renders. Split from the .tsx so it is fixture-testable with mock
// endpoint data (repo convention: no component-render unit tests).

export const AVAILABILITY_KEYS = {
  stable: "settings.capabilities.availability.stable",
  maintenance_only: "settings.capabilities.availability.maintenance_only",
  disabled: "settings.capabilities.availability.disabled",
  unavailable: "settings.capabilities.availability.unavailable",
} as const

export type CapabilityAvailability = keyof typeof AVAILABILITY_KEYS

export const isAvailability = (value: string): value is CapabilityAvailability => value in AVAILABILITY_KEYS

/** Stable i18n key for an availability value (unknown values pass through raw). */
export const availabilityKey = (availability: string) =>
  isAvailability(availability) ? AVAILABILITY_KEYS[availability] : availability

export type CatalogRow = {
  readonly id: string
  readonly version: string
  readonly summary: string
  readonly availability: string
  readonly availabilityKey: string
  readonly entryTools: readonly string[]
}

/** L0 catalog rows (name = id, description = summary, availability tag). */
export const catalogRows = (catalog: CapabilityCatalog | undefined): readonly CatalogRow[] =>
  (catalog?.capabilities ?? []).map((item) => ({
    id: item.id,
    version: item.version,
    summary: item.summary,
    availability: item.availability,
    availabilityKey: availabilityKey(item.availability),
    entryTools: item.entry_tools,
  }))

export type ReceiptRow = {
  readonly capabilityId: string
  readonly version: string
  readonly bodyRef: string
  readonly bodyHash: string
  readonly tokenCount: number
  readonly byteCount: number
}

/** Load receipt rows (identity + metrics, never a body). */
export const receiptRows = (receipts: CapabilityLoadReceipts | undefined): readonly ReceiptRow[] =>
  (receipts?.receipts ?? []).map((receipt) => ({
    capabilityId: receipt.capabilityId,
    version: receipt.version,
    bodyRef: receipt.bodyRef,
    bodyHash: receipt.bodyHash,
    tokenCount: receipt.tokenCount,
    byteCount: receipt.byteCount,
  }))

export type SnapshotRow = {
  readonly catalogSnapshotId: string
  readonly catalogDigest: string
  readonly catalogDigestConsistent: boolean
  readonly l0LineCount: number
}

export const snapshotRow = (snapshot: SystemContextSnapshot | undefined): SnapshotRow | undefined =>
  snapshot
    ? {
        catalogSnapshotId: snapshot.catalogSnapshotId,
        catalogDigest: snapshot.catalogDigest,
        catalogDigestConsistent: snapshot.catalogDigestConsistent,
        l0LineCount: snapshot.l0LineCount,
      }
    : undefined
