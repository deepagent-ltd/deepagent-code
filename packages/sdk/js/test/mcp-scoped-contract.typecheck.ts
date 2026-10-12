import type {
  CommandListErrors,
  CommandListResponses,
  CommandRead,
  ExperimentalResourceListErrors,
  McpAddData,
  McpAddErrors,
  McpAuthAuthenticateErrors,
  McpAuthCallbackErrors,
  McpAuthRemoveErrors,
  McpAuthStartErrors,
  McpCatalogEnableErrors,
  McpCatalogErrors,
  McpConnectErrors,
  McpDisconnectErrors,
  McpStatus,
  McpStatusErrors,
} from "../src/gen/types.gen.js"

type Assert<T extends true> = T
type Disconnected = Extract<McpStatus, { status: "disconnected" }>

export type ScopedMcpContract = [
  Assert<{} extends Pick<McpAddData, "body"> ? false : true>,
  Assert<
    Disconnected["authStatus"] extends
      | "authenticated"
      | "expired"
      | "not_authenticated"
      | "legacy_unverified"
      | "unknown"
      ? true
      : false
  >,
  Assert<
    Disconnected["reason"] extends "explicit_connect_required" | "scope_changed" | "unknown_outcome" ? true : false
  >,
  Assert<McpAddErrors[401]["error"] extends string ? true : false>,
  Assert<McpCatalogEnableErrors[401]["error"] extends string ? true : false>,
  Assert<McpAuthStartErrors[401]["error"] extends string ? true : false>,
  Assert<McpAuthCallbackErrors[401]["error"] extends string ? true : false>,
  Assert<McpAuthAuthenticateErrors[401]["error"] extends string ? true : false>,
  Assert<McpAuthRemoveErrors[401]["error"] extends string ? true : false>,
  Assert<McpConnectErrors[401]["error"] extends string ? true : false>,
  Assert<McpDisconnectErrors[401]["error"] extends string ? true : false>,
  Assert<McpConnectErrors[409]["error"] extends string ? true : false>,
]

export const coldUnknown = {
  status: "disconnected",
  authStatus: "unknown",
  reason: "unknown_outcome",
} satisfies McpStatus

export type ReadonlyMcpContract = [
  Assert<{} extends Pick<CommandRead, "template"> ? true : false>,
  Assert<{} extends Pick<CommandRead, "availability"> ? true : false>,
  Assert<NonNullable<CommandRead["availability"]> extends "available" | "connect_required" | "unavailable" ? true : false>,
  Assert<CommandListResponses[200][number] extends CommandRead ? true : false>,
  Assert<401 extends keyof CommandListErrors ? true : false>,
  Assert<CommandListErrors[503]["_tag"] extends "ServiceUnavailableError" ? true : false>,
  Assert<McpStatusErrors[503]["message"] extends string ? true : false>,
  Assert<McpCatalogErrors[503]["message"] extends string ? true : false>,
  Assert<ExperimentalResourceListErrors[503]["message"] extends string ? true : false>,
]

export const observedCommand = {
  name: "fixture_prompt",
  hints: [],
  source: "mcp",
  availability: "connect_required",
} satisfies CommandRead
