/**
 * Generate the static JSON Schema for `~/.deepagent/code/config.jsonc`.
 *
 * The single artifact this generator produces is
 * `https://ai.deepagent.ltd/config.schema.json` — the URL the runtime stamps
 * into the `$schema` key of config files by default. It is editor-facing only:
 * the runtime validates configuration in-process with the Effect schema
 * (ConfigV1.Info), and never fetches this file. Editors (VS Code / JSON
 * language service) fetch it once for validation, autocomplete and hover docs.
 *
 * Usage: `bun packages/core/script/gen-config-schema.ts > config.schema.json`
 */
import { Schema } from "effect"
import { ConfigV1 } from "../src/v1/config/config"

const doc = Schema.toJsonSchemaDocument(ConfigV1.Info)

// Normalize the Effect envelope ({ dialect, schema, definitions }) into a
// standard draft-2020-12 document editors understand, pinned to the hosted URL.
const output = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://ai.deepagent.ltd/config.schema.json",
  ...doc.schema,
  ...(Object.keys(doc.definitions).length > 0 ? { $defs: doc.definitions } : {}),
}

console.log(JSON.stringify(output, null, 2))
