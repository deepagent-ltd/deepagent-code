import { CLIENT_ERROR_CODES, FACADE_ERROR_CODES } from "@deepagent-code/core/im/facade-contract"
import type { TuiI18nKey } from "../i18n/en"
import type { TuiI18n } from "../context/i18n"
import { IMRequestError } from "./im-client"
import { MediaPublicationError } from "./im-media"

export const IM_ERROR_KEYS = {
  im_unavailable: "tui.im.facade.error.im_unavailable",
  im_not_claimed: "tui.im.facade.error.im_not_claimed",
  im_identity_disabled: "tui.im.facade.error.im_identity_disabled",
  im_invalid_name: "tui.im.facade.error.im_invalid_name",
  im_name_taken: "tui.im.facade.error.im_name_taken",
  im_key_invalid: "tui.im.facade.error.im_key_invalid",
  im_cross_org: "tui.im.facade.error.im_cross_org",
  im_key_already_bound: "tui.im.facade.error.im_key_already_bound",
  im_not_found: "tui.im.facade.error.im_not_found",
  im_member_not_found: "tui.im.facade.error.im_member_not_found",
  im_not_group_member: "tui.im.facade.error.im_not_group_member",
  im_invalid_group: "tui.im.facade.error.im_invalid_group",
  im_source_identity_missing: "tui.im.facade.error.im_source_identity_missing",
  im_identity_changed: "tui.im.facade.error.im_identity_changed",
  im_kernel_error: "tui.im.facade.error.im_kernel_error",
  transport_error: "tui.im.facade.error.transport_error",
  invalid_response: "tui.im.facade.error.invalid_response",
  http_error: "tui.im.facade.error.http_error",
  invalid_request: "tui.im.facade.error.invalid_request",
} as const satisfies Record<
  (typeof FACADE_ERROR_CODES)[number] | (typeof CLIENT_ERROR_CODES)[number] | "im_identity_changed",
  TuiI18nKey
>

export function imErrorText(error: unknown, i18n: TuiI18n) {
  if (error instanceof MediaPublicationError) return i18n.t("tui.im.media.publicationUnknown")
  const code = error instanceof IMRequestError ? error.code : "unknown"
  if (code.startsWith("reader_") || code === "IM_READER_UNAVAILABLE") return i18n.t("tui.im.reader.unavailable")
  if (code === "key_file") return i18n.t("tui.im.keyFileError")
  if (code === "im_model_unavailable") return i18n.t("tui.im.model.unavailable")
  if (code === "im_activation_missing") return i18n.t("tui.im.activation.missing")
  if (code === "im_activation_expired") return i18n.t("tui.im.activation.expired")
  if (code === "im_activation_unavailable") return i18n.t("tui.im.activation.unavailable")
  if (code === "dac_local_only") return i18n.t("tui.im.dac.localOnly")
  if (code === "dac_scope_changed" || code === "binding_unavailable" || code === "reference_unavailable")
    return i18n.t("tui.im.dac.unavailable")
  if (code === "command_conflict") return i18n.t("tui.im.dac.unknown")
  return i18n.t((IM_ERROR_KEYS as Record<string, TuiI18nKey>)[code] ?? "tui.im.facade.error.unknown")
}
