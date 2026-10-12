export * as VendorContextBound from "./vendor-context-bound"

// Reviewed 2026-10-10. This bounds accepted input; it is not a tokenizer estimate or
// a promise of an immutable vendor deployment. Over-context requests are rejected.
// https://api-docs.deepseek.com/quick_start/pricing/
// https://api-docs.deepseek.com/guides/responses_api/
export const DEEPSEEK_FLASH = Object.freeze({
  id: "deepseek-flash-responses-context-upper-bound-v1",
  providerID: "deepseek",
  modelID: "deepseek-flash",
  modelRevision: "deepseek-flash:vendor-alias:context-cap-20261010-v1",
  endpoint: "https://api.deepseek.com/responses",
  counterEndpoint: "dac-local://deepseek/flash/context-upper-bound-v1",
  semantics: "vendor_context_input_upper_bound" as const,
  inputUpperBound: 1_048_576,
  completionLimit: 32_768,
  inputProjection: "deepseek-responses-project-context-bound.v1" as const,
  tokenizerIdentity: "deepseek-flash:vendor-context-cap:1048576:v1",
})
