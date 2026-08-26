import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import DESCRIPTION from "./question.txt"

export const Parameters = Schema.Struct({
  questions: Schema.mutable(Schema.Array(Question.Prompt)).annotate({ description: "Questions to ask" }),
})

type Metadata = {
  answers: ReadonlyArray<Question.Answer>
}

export const QuestionTool = Tool.define<typeof Parameters, Metadata, Question.Service>(
  "question",
  Effect.gen(function* () {
    const question = yield* Question.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          // Soft guard (recoverable, matches the plan-gate feedback model in session/tools.ts):
          // the parameter schema requires `options` to be PRESENT, but an empty array `[]` still
          // decodes — and a choice question with zero options is unanswerable, so `ask` would block
          // forever on a reply that can never come, hanging the whole turn. Reject it here with an
          // instructive tool-result instead of publishing a dead question. `questions` itself being
          // empty is the same class of degenerate input.
          const invalid: string[] = []
          if (params.questions.length === 0) invalid.push("`questions` is empty — provide at least one question")
          params.questions.forEach((q, i) => {
            if (!q.options || q.options.length === 0)
              invalid.push(`questions[${i}] ("${q.header || q.question}") has no options — every question needs at least one`)
          })
          if (invalid.length > 0) {
            return {
              title: "Invalid question input",
              output: `The question tool was called with unanswerable input: ${invalid.join("; ")}.\nEach question must carry a non-empty \`options\` array. Please rewrite the input and call the tool again.`,
              metadata: { answers: [] },
            }
          }

          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: params.questions,
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          const formatted = params.questions
            .map((q, i) => `"${q.question}"="${answers[i]?.length ? answers[i].join(", ") : "Unanswered"}"`)
            .join(", ")

          return {
            title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
            output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
            metadata: {
              answers,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
