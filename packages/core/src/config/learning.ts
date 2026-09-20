export * as ConfigLearning from "./learning"

import { Schema } from "effect"

// W7 — durable learning / memory output-position policy. The canonical storage root stays
// `~/.deepagent/code/project/<pid>/knowledge` (the DurableKnowledgeStore root); `project_copy` is
// the OPTIONAL mirror of released learning selections into the project tree.
export class Info extends Schema.Class<Info>("ConfigV2.Learning")({
  project_copy: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Mirror released knowledge/memory selections into the project docs/deepagent/ directory (W7; default false — the durable store under the agent data root remains the single authority)",
  }),
}) {}
