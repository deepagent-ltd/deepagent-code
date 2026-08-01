import { describe, expect, test } from "bun:test"
import { ContextFederationContract } from "@deepagent-code/core/context-federation/contract"
import { ProviderTransform } from "@/provider/transform"
import { Provider } from "@/provider/provider"
import { Parameters as LegacyCodeIntelInput } from "@/tool/code_intel"
import { CodeIntelV2Parameters } from "@/tool/code_intel_v2"
import { ContextQueryParameters } from "@/tool/context_query"
import { ToolJsonSchema } from "@/tool/json-schema"

const providers = {
  "openai-responses": { providerID: "openai", api: { id: "gpt-5", npm: "@ai-sdk/openai" } },
  "openai-compatible-chat": {
    providerID: "openrouter",
    api: { id: "gpt-4o", npm: "@ai-sdk/openai-compatible" },
  },
  "anthropic-messages": {
    providerID: "anthropic",
    api: { id: "claude-sonnet-4-5", npm: "@ai-sdk/anthropic" },
  },
  gemini: { providerID: "google", api: { id: "gemini-2.5-flash", npm: "@ai-sdk/google" } },
  "bedrock-converse": {
    providerID: "amazon-bedrock",
    api: { id: "anthropic.claude-sonnet-4-5", npm: "@ai-sdk/amazon-bedrock" },
  },
} as const

const protocols = Object.keys(providers) as Array<keyof typeof providers>
const snapshot = (await Bun.file(new URL("./fixtures/provider-tool-schemas.v1.json", import.meta.url)).json()) as {
  readonly schemaVersion: string
  readonly protocols: readonly string[]
  readonly legacy: {
    readonly contextQueryPresent: boolean
    readonly codeIntel: { readonly schemaVersion: number; readonly hashes: Readonly<Record<string, string>> }
  }
  readonly target: {
    readonly codeIntel: { readonly schemaVersion: number; readonly hashes: Readonly<Record<string, string>> }
    readonly contextQuery: { readonly schemaVersion: number; readonly hashes: Readonly<Record<string, string>> }
  }
}

describe("four-graph Provider tool schema baseline", () => {
  test("pins the legacy boundary before migration", async () => {
    expect(snapshot.schemaVersion).toBe("context-federation-provider-tool-baseline.v1")
    expect(snapshot.protocols).toEqual(protocols)
    expect(snapshot.legacy.contextQueryPresent).toBe(false)
    expect(hashes(LegacyCodeIntelInput)).toEqual(snapshot.legacy.codeIntel.hashes)
  })

  test("pins the reviewed v2 tool schemas for every target Provider protocol", () => {
    expect(snapshot.target.codeIntel.schemaVersion).toBe(ContextFederationContract.Version.codeIntel)
    expect(snapshot.target.contextQuery.schemaVersion).toBe(ContextFederationContract.Version.contextQuery)
    expect(hashes(ContextFederationContract.CodeIntelInput)).toEqual(snapshot.target.codeIntel.hashes)
    expect(hashes(ContextFederationContract.ContextQueryInput)).toEqual(snapshot.target.contextQuery.hashes)
    expect(hashes(CodeIntelV2Parameters)).toEqual(snapshot.target.codeIntel.hashes)
    expect(hashes(ContextQueryParameters)).toEqual(snapshot.target.contextQuery.hashes)
  })
})

function hashes(schema: Parameters<typeof ToolJsonSchema.fromSchema>[0]) {
  return Object.fromEntries(
    protocols.map((protocol) => [
      protocol,
      new Bun.CryptoHasher("sha256")
        .update(
          canonicalJson(
            ProviderTransform.schema(
              providers[protocol] as unknown as Provider.Model,
              ToolJsonSchema.fromSchema(schema),
            ),
          ),
        )
        .digest("hex"),
    ]),
  )
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value !== "object") return JSON.stringify(value) ?? "null"
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`
}
