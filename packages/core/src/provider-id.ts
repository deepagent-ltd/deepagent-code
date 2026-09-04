export * as ProviderID from "./provider-id"

import { Schema } from "effect"
import { withStatics } from "./schema"

// Schema-only Provider ID extracted from provider.ts (which owns the
// contract/model-protocol edge) for the browser-bundle isolation program —
// see model/ref, location/ref, event/define for the same pattern.
export const ID = Schema.String.pipe(
  Schema.brand("ProviderV2.ID"),
  withStatics((schema) => ({
    // Well-known providers
    "deepagent-code": schema.make("deepagent-code"),
    anthropic: schema.make("anthropic"),
    openai: schema.make("openai"),
    google: schema.make("google"),
    googleVertex: schema.make("google-vertex"),
    githubCopilot: schema.make("github-copilot"),
    amazonBedrock: schema.make("amazon-bedrock"),
    azure: schema.make("azure"),
    openrouter: schema.make("openrouter"),
    mistral: schema.make("mistral"),
    gitlab: schema.make("gitlab"),
  })),
)
export type ID = typeof ID.Type
