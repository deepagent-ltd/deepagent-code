import { describe, expect, test } from "bun:test"
import { HttpApiError } from "effect/unstable/httpapi"
import { SessionProviderResolution } from "@/session/provider-resolution"
import { ApiNotFoundError, ConflictError, ServiceUnavailableError } from "@/server/routes/instance/httpapi/errors"
import { mapProviderResolutionError } from "@/server/routes/instance/httpapi/handlers/session-errors"

describe("legacy provider-resolution HTTP refusal mapping", () => {
  const map = mapProviderResolutionError("session.provider-resolution-command")

  test("missing targets and malformed command bindings are client errors", () => {
    for (const code of [
      "target_required",
      "target_ambiguous",
      "command_id_required",
      "legacy_binding_required",
    ] as const)
      expect(map(new SessionProviderResolution.Unsupported({ code, reason: code }))).toBeInstanceOf(
        HttpApiError.BadRequest,
      )
  })

  test("unavailable exits retain their authority distinction", () => {
    for (const code of ["exit_not_available_on_authority", "legacy_receipt_bound_use_legacy_authority"] as const) {
      const error = map(new SessionProviderResolution.Unsupported({ code, reason: code }))
      expect(error).toBeInstanceOf(ConflictError)
      expect(error).toMatchObject({ resource: code })
    }
    expect(
      map(
        new SessionProviderResolution.Unsupported({
          code: "exit_requires_maintenance_authority",
          reason: "maintenance only",
        }),
      ),
    ).toBeInstanceOf(ServiceUnavailableError)
  })

  test("not-found and durable conflicts preserve their existing wire classes", () => {
    expect(map(new SessionProviderResolution.NotFound({ reason: "missing" }))).toBeInstanceOf(ApiNotFoundError)
    expect(
      map(new SessionProviderResolution.Conflict({ code: "recovery_authority_conflict", reason: "stale" })),
    ).toMatchObject({ resource: "recovery_authority_conflict" })
  })
})
