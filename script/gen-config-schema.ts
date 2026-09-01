/**
 * Generate the static JSON Schema for `~/.deepagent/code/config.jsonc`.
 *
 * The schema is hosted at https://ai.deepagent.ltd/config.schema.json and is
 * referenced by the `$schema` key the runtime writes by default, so editors
 * (VS Code / JSON language service) can validate, autocomplete and hover the
 * config file. The runtime itself never fetches it — validation is the
 * in-process Effect schema (ConfigV1.Info) — this artifact is editor-facing.
 */
import { Schema } from "effect"
import { ConfigV1 } from "../packages/core/src/v1/config/config"

const doc = Schema.toJsonSchemaDocument(ConfigV1.Info)
doc["$id"] = "https://ai.deepagent.ltd/config.schema.json"
doc["$schema"] = "https://json-schema.org/draft-07/schema#"
console.log(JSON.stringify(doc, null, 2))
