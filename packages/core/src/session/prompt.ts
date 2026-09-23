import * as Schema from "effect/Schema"

export class Source extends Schema.Class<Source>("Prompt.Source")({
  start: Schema.Finite,
  end: Schema.Finite,
  text: Schema.String,
}) {}

export class FileAttachment extends Schema.Class<FileAttachment>("Prompt.FileAttachment")({
  uri: Schema.String,
  mime: Schema.String,
  name: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  source: Source.pipe(Schema.optional),
}) {
  static create(input: FileAttachment) {
    return new FileAttachment({
      uri: input.uri,
      mime: input.mime,
      name: input.name,
      description: input.description,
      source: input.source,
    })
  }
}

export class AgentAttachment extends Schema.Class<AgentAttachment>("Prompt.AgentAttachment")({
  name: Schema.String,
  source: Source.pipe(Schema.optional),
}) {}

// UPD-002/RI-126: structured-output format requested with the prompt. Mirrors the legacy
// SessionV1.Format json_schema variant; the V2 runner either lowers it onto the wire
// (`responseFormat`, Responses-family + format-capable routes) or synthesizes the
// StructuredOutput tool for chat routes.
export class OutputFormat extends Schema.Class<OutputFormat>("Prompt.OutputFormat")({
  type: Schema.Literals(["text", "json_schema"]),
  schema: Schema.Record(Schema.String, Schema.Any).pipe(Schema.optional),
  retryCount: Schema.Int.pipe(Schema.optional),
}) {}

export class ReferenceAttachment extends Schema.Class<ReferenceAttachment>("Prompt.ReferenceAttachment")({
  name: Schema.String,
  kind: Schema.Literals(["local", "git", "invalid"]),
  uri: Schema.String.pipe(Schema.optional),
  repository: Schema.String.pipe(Schema.optional),
  branch: Schema.String.pipe(Schema.optional),
  target: Schema.String.pipe(Schema.optional),
  targetUri: Schema.String.pipe(Schema.optional),
  problem: Schema.String.pipe(Schema.optional),
  source: Source.pipe(Schema.optional),
}) {}

export class Prompt extends Schema.Class<Prompt>("Prompt")({
  text: Schema.String,
  files: Schema.Array(FileAttachment).pipe(Schema.optional),
  agents: Schema.Array(AgentAttachment).pipe(Schema.optional),
  references: Schema.Array(ReferenceAttachment).pipe(Schema.optional),
  format: OutputFormat.pipe(Schema.optional),
  metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
  intent: Schema.Struct({
    id: Schema.String.pipe(Schema.optional),
    source: Schema.String.pipe(Schema.optional),
    variant: Schema.String.pipe(Schema.optional),
  }).pipe(Schema.optional),
  agent: Schema.String.pipe(Schema.optional),
  model: Schema.Struct({
    id: Schema.String,
    providerID: Schema.String,
    variant: Schema.String.pipe(Schema.optional),
  }).pipe(Schema.optional),
}) {
  static readonly equivalence = Schema.toEquivalence(Prompt)

  static fromUserMessage(input: Pick<Prompt, "text" | "files" | "agents" | "references" | "format">) {
    return new Prompt({
      text: input.text,
      ...(input.files === undefined ? {} : { files: input.files }),
      ...(input.agents === undefined ? {} : { agents: input.agents }),
      ...(input.references === undefined ? {} : { references: input.references }),
      ...(input.format === undefined ? {} : { format: input.format }),
    })
  }
}
