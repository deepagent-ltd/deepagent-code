export * as MigrationIdentity from "./migration-identity"

export const Canonical = {
  finalAuthorities: "20260813040301_final_authorities",
  eventMaintenance: "20260813074240_event_maintenance",
  eventSidecarLifecycle: "20260813141000_event_sidecar_lifecycle",
  eventSidecarIndexes: "20260813142000_event_sidecar_indexes",
  eventAggregateIndexes: "20260813143000_event_aggregate_indexes",
} as const

// These values are persisted in released databases. Keep them as aliases so renaming source
// artifacts cannot make an installed database replay schema work it has already completed.
export const Historical = {
  finalAuthorities: `20260813040301_${["bug", "407"].join("")}_final_authorities`,
  eventMaintenance: ["20260813074240", "bug", "407", "010", "maintenance"].join("_"),
  eventSidecarLifecycle: ["20260813141000", "bug", "407", "010", "sidecar", "lifecycle"].join("_"),
  eventSidecarIndexes: ["20260813142000", "bug", "407", "010", "sidecar", "indexes"].join("_"),
  eventAggregateIndexes: ["20260813143000", "bug", "407", "010", "aggregate", "indexes"].join("_"),
} as const
