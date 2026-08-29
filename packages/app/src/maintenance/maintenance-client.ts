import type {
  BackupList,
  BackupVerify,
  BootstrapState,
  BootstrapStatusOutcome,
  EvidenceExportInput,
  EvidenceExportManifest,
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

// LIC3 client for the C6-01 maintenance HTTP surface (design §11.1). The generated
// JS SDK does not yet expose the `maintenance` group (that is C6-04 / LIC2), so the
// shell consumes the API through this thin typed fetch against the same base URL +
// auth headers the SDK uses. It is deliberately transport-only: no business logic,
// no parsing of `message`. Decisions come from `code` / `httpStatus` / `actual`.
//
// The component boundary is dependency-injected (`client` prop) so fixtures can
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

async function request(
  config: MaintenanceClientConfig,
  method: "get" | "post",
  path: string,
  input?: { query?: Record<string, string | number | undefined>; payload?: unknown },
): Promise<WireResponse> {
  const fetchImpl = config.fetch ?? globalThis.fetch
  const url = new URL(path.startsWith("/") ? path : `/${path}`, config.baseUrl)
  if (input?.query) {
    for (const [key, value] of Object.entries(input.query)) {
      if (value === undefined) continue
      url.searchParams.set(key, String(value))
    }
  }
  const response = await fetchImpl(url.toString(), {
    method: method.toUpperCase(),
    headers: {
      "content-type": "application/json",
      ...(config.headers ?? EMPTY_HEADERS),
    },
    body: method === "post" && input?.payload !== undefined ? JSON.stringify(input.payload) : undefined,
  })
  const body = await response.text()
  return { status: response.status, body }
}

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

function ok<T>(response: WireResponse): MaintenanceResult<T> {
  if (response.status >= 200 && response.status < 300) return { data: decodeBody<T>(response.body) }
  const decoded = errorFrom(response)
  if ("kind" in decoded) return { failure: decoded }
  return { error: decoded }
}

/**
 * Map a bootstrap/status response (200 ready OR a typed 423/503 for a read-only /
 * blocked store) to a normalized outcome. A 200 carries the full BootstrapState; a
 * typed error carries `actual` (the mode) + `code`, never a raw path/credential.
 */
export function decodeBootstrapStatus(response: WireResponse): BootstrapStatusOutcome {
  if (response.status >= 200 && response.status < 300) {
    return { kind: "ready", state: decodeBody<BootstrapState>(response.body) }
  }
  const decoded = errorFrom(response)
  if ("kind" in decoded) {
    // Network/decode-level (e.g. the server could not serve bootstrap): the shell
    // still renders, but with an "unreachable" outcome rather than blocking the app.
    return { kind: "unreachable", error: decoded }
  }
  // A typed C0-03 envelope encodes the store mode in `actual` and the failure class in `code`.
  const envelope = decoded.data
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

export function createMaintenanceClient(config: MaintenanceClientConfig): MaintenanceClient {
  return {
    async bootstrapStatus() {
      const response = await request(config, "get", "/bootstrap/status")
      return decodeBootstrapStatus(response)
    },
    async listBackups(dir) {
      const response = await request(config, "get", "/backup/list", { query: { dir } })
      return ok<BackupList>(response)
    },
    async verifyBackup(manifestPath) {
      const response = await request(config, "get", "/backup/verify", { query: { manifest_path: manifestPath } })
      return ok<BackupVerify>(response)
    },
    async restoreBackup(input) {
      const response = await request(config, "post", "/backup/restore", { payload: input })
      return ok<RestoreStatus>(response)
    },
    async recoveryList(sessionId) {
      const response = await request(config, "get", "/recovery/list", { query: { session_id: sessionId } })
      return ok<RecoveryList>(response)
    },
    async recoveryCommand(input) {
      const response = await request(config, "post", "/recovery/command", { payload: input })
      return ok<RecoveryCommandResult>(response)
    },
    async recoveryCommandGet(commandId) {
      const response = await request(config, "get", "/recovery/commandGet", { query: { command_id: commandId } })
      return ok<RecoveryDescriptorRecord>(response)
    },
    async recoveryEvidenceExport(exportId) {
      const response = await request(config, "get", "/recovery/evidenceExport", { query: { export_id: exportId } })
      return ok<EvidenceExportManifest>(response)
    },
    async createRecoveryEvidenceExport(input) {
      const response = await request(config, "post", "/recovery/evidenceExport", { payload: input })
      return ok<EvidenceExportManifest>(response)
    },
  }
}
