import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import type {
  BackupList,
  BackupVerify,
  BootstrapState,
  BootstrapStatusOutcome,
  EvidenceExportInput,
  EvidenceExportManifest,
  MaintenanceErrorEnvelope,
  MaintenanceFailure,
  MaintenanceHttpError,
  MaintenanceResult,
  RecoveryCommandInput,
  RecoveryCommandResult,
  RecoveryDescriptorRecord,
  RecoveryList,
  RestoreInput,
  RestoreStatus,
} from "./types"

// LIC3 integration (C6-04): the maintenance HTTP surface is now part of the unified
// generated SDK (C6-01..04), so the LIC3 hand-written fetch transport is replaced by
// the generated DeepAgentCodeClient (`@deepagent-code/sdk/client`) against the same
// base URL + auth headers. The exported contract is deliberately unchanged:
// decisions come from `code` / `httpStatus` / `actual`, never from `message`.
//
// The component boundary stays dependency-injected (`client` prop) so fixtures can
// drive it in tests without a live server (fixture/in-memory only).

export interface MaintenanceClient {
  bootstrapStatus(): Promise<BootstrapStatusOutcome>
  listBackups(dir?: string): Promise<MaintenanceResult<BackupList>>
  verifyBackup(manifestPath: string): Promise<MaintenanceResult<BackupVerify>>
  restoreBackup(input: RestoreInput): Promise<MaintenanceResult<RestoreStatus>>
  recoveryList(sessionId: string): Promise<MaintenanceResult<RecoveryList>>
  recoveryCommand(input: RecoveryCommandInput): Promise<MaintenanceResult<RecoveryCommandResult>>
  recoveryCommandGet(commandId: string): Promise<MaintenanceResult<RecoveryDescriptorRecord>>
  recoveryEvidenceExport(exportId: string): Promise<MaintenanceResult<EvidenceExportManifest>>
  createRecoveryEvidenceExport(input: EvidenceExportInput): Promise<MaintenanceResult<EvidenceExportManifest>>
}

export interface MaintenanceClientConfig {
  baseUrl: string
  headers?: Record<string, string>
  fetch?: typeof globalThis.fetch
}

interface WireResponse {
  status: number
  body: string
}

const EMPTY_HEADERS = {}

function decodeBody<D>(body: string): D {
  return JSON.parse(body) as D
}

/** Decode the C0-03 typed error body `{ name, data }` (typed-error.ts). */
export function isMaintenanceHttpError(value: unknown): value is MaintenanceHttpError {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "data" in value &&
    typeof (value as { data?: unknown }).data === "object" &&
    (value as { data: object }).data !== null &&
    "code" in (value as { data: object }).data
  )
}

function errorFrom(response: WireResponse): MaintenanceHttpError | MaintenanceFailure {
  let parsed: unknown
  try {
    parsed = JSON.parse(response.body)
  } catch {
    // A non-JSON body is a transport failure, never a C0-03 decision.
    return { kind: "network", message: `expected JSON (http ${response.status})` }
  }
  // The wire convention is `{ name, data }` where `data` is the C0-03 envelope.
  if (isMaintenanceHttpError(parsed)) return parsed
  return { kind: "decode", message: "unexpected response body" }
}

/**
 * The shared ready decision: a 200 carries the full BootstrapState (never a raw
 * path/credential).
 */
function bootstrapOutcomeFromType(state: BootstrapState): BootstrapStatusOutcome {
  return { kind: "ready", state }
}

function bootstrapOutcomeFromError(envelope: MaintenanceErrorEnvelope): BootstrapStatusOutcome {
  const mode = envelope.actual === "read_only_recovery" ? "read_only_recovery" : "blocked_schema"
  const phase = mode === "read_only_recovery" ? "read_only_recovery" : "blocked_schema"
  const state: BootstrapState = {
    phase,
    mode,
    ready: false,
    diagnostics: {
      stableCode: envelope.code,
      mode,
      phase,
      buildDigest: "",
      correlationId: envelope.correlationId,
      message: envelope.message ?? "",
    },
    next: null,
  }
  return mode === "read_only_recovery" ? { kind: "read_only_recovery", state } : { kind: "blocked_schema", state }
}

/**
 * Map a bootstrap/status response (200 ready OR a typed 423/503 for a read-only /
 * blocked store) to a normalized outcome. A 200 carries the full BootstrapState; a
 * typed error carries `actual` (the mode) + `code`, never a raw path/credential.
 */
export function decodeBootstrapStatus(response: WireResponse): BootstrapStatusOutcome {
  if (response.status >= 200 && response.status < 300) {
    return bootstrapOutcomeFromType(decodeBody<BootstrapState>(response.body))
  }
  const decoded = errorFrom(response)
  if ("kind" in decoded) {
    // Network/decode-level (e.g. the server could not serve bootstrap): the shell
    // still renders, but with an "unreachable" outcome rather than blocking the app.
    return { kind: "unreachable", error: decoded }
  }
  return bootstrapOutcomeFromError(decoded.data)
}

/** Generated client result → the normalized `MaintenanceResult` (typed error vs transport failure). */
async function fromSdk<T>(
  call: () => Promise<{ data?: unknown; error?: unknown; response?: Response }>,
): Promise<MaintenanceResult<T>> {
  try {
    const result = await call()
    if (result.data !== undefined) return { data: result.data as T }
    if (isMaintenanceHttpError(result.error)) return { error: result.error }
    if (result.error !== undefined) return { failure: { kind: "decode", message: "unexpected response body" } }
    return { failure: { kind: "network", message: "empty response" } }
  } catch {
    return { failure: { kind: "network", message: "request failed" } }
  }
}

export function createMaintenanceClient(config: MaintenanceClientConfig): MaintenanceClient {
  const client = createDeepAgentCodeClient({
    baseUrl: config.baseUrl,
    fetch: config.fetch,
    headers: config.headers ?? EMPTY_HEADERS,
  })
  return {
    async bootstrapStatus() {
      const result = await fromSdk<BootstrapState>(() => client.maintenance.bootstrap.status())
      if ("data" in result) return bootstrapOutcomeFromType(result.data)
      if ("error" in result) return bootstrapOutcomeFromError(result.error.data)
      return { kind: "unreachable", error: result.failure }
    },
    async listBackups(dir) {
      return fromSdk<BackupList>(() => client.maintenance.backup.list({ dir }))
    },
    async verifyBackup(manifestPath) {
      return fromSdk<BackupVerify>(() => client.maintenance.backup.verify({ manifest_path: manifestPath }))
    },
    async restoreBackup(input) {
      return fromSdk<RestoreStatus>(() => client.maintenance.backup.restore({ restoreInput: input }))
    },
    async recoveryList(sessionId) {
      return fromSdk<RecoveryList>(() => client.maintenance.recovery.list({ session_id: sessionId }))
    },
    async recoveryCommand(input) {
      return fromSdk<RecoveryCommandResult>(() => client.maintenance.recovery.command({ recoveryCommandInput: input }))
    },
    async recoveryCommandGet(commandId) {
      return fromSdk<RecoveryDescriptorRecord>(() => client.maintenance.recovery.commandGet({ command_id: commandId }))
    },
    async recoveryEvidenceExport(exportId) {
      return fromSdk<EvidenceExportManifest>(() => client.maintenance.recovery.evidenceExport({ export_id: exportId }))
    },
    async createRecoveryEvidenceExport(input) {
      return fromSdk<EvidenceExportManifest>(() => client.maintenance.recovery.evidenceExport2.create({ evidenceExportInput: input }))
    },
  }
}
