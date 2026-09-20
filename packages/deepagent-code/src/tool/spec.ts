import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./spec.txt"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"

// W4 (gap audit B3): the run document set writer. The full-document-set design declared
// requirements/design DocTypes with no production writer — the model had no way to record its
// understanding or design as durable run documents, so the document graph's doc branch was
// structurally empty. Writes land in the SAME session store as the plan (the run document set),
// with model provenance; re-writing the same title bumps the version (iterative refinement).
const Parameters = Schema.Struct({
  operation: Schema.optional(Schema.Literals(["write", "list"])).annotate({
    description: "write a document (default) or list this session's documents",
  }),
  kind: Schema.optional(Schema.Literals(["requirements", "design"])).annotate({
    description:
      "requirements = what the task demands (contracts, constraints, acceptance); design = how it will be built (structure, approach, tradeoffs)",
  }),
  title: Schema.optional(Schema.String).annotate({
    description: "short document title; re-using a title refines the same document (new version)",
  }),
  body: Schema.optional(Schema.String).annotate({
    description: "the document body in markdown",
  }),
})

type Metadata = {
  operation: "write" | "list"
  kind: string | null
  version: number | null
}

export const SpecTool = Tool.define<typeof Parameters, Metadata, never>(
  "spec",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const operation = params.operation ?? "write"
          if (operation === "list") {
            const docs = AgentGateway.DeepAgentPlanStore.listSpecDocs(ctx.sessionID)
            return {
              title: `run documents (${docs.length})`,
              output:
                docs.length === 0
                  ? "No run documents yet. Write the requirements and design before implementing."
                  : docs.map((doc) => `- [${doc.kind}] ${doc.description} (v${doc.version}, ${doc.id})`).join("\n"),
              metadata: { operation, kind: null, version: null },
            }
          }
          if (!params.kind || !params.title || !params.body) {
            return {
              title: "spec write needs kind, title and body",
              output:
                "Provide kind (requirements|design), a short title, and the markdown body. Requirements capture WHAT the task demands; design captures HOW you will build it.",
              metadata: { operation, kind: params.kind ?? null, version: null },
            }
          }
          const written = AgentGateway.DeepAgentPlanStore.writeSpecDoc(ctx.sessionID, {
            kind: params.kind,
            title: params.title,
            body: params.body,
          })
          return {
            title: `${params.kind}: ${params.title} (v${written.version})`,
            output: `Stored as a durable run document (${written.id}, version ${written.version}). It stays readable via spec list and survives this turn.`,
            metadata: { operation, kind: params.kind, version: written.version },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
