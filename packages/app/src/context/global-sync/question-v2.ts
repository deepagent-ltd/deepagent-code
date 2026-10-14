import type { DeepAgentCodeClient, QuestionAnswer } from "@deepagent-code/sdk/client"

type QuestionRoute = { sessionID: string; requestID: string; directory?: string; v2?: boolean }

export async function replyQuestion(client: DeepAgentCodeClient, input: QuestionRoute & { answers: QuestionAnswer[] }) {
  if (input.v2) {
    await client.v2.session.question.reply(
      {
        sessionID: input.sessionID,
        requestID: input.requestID,
        questionV2Reply: { answers: input.answers },
      },
      { throwOnError: true },
    )
    return
  }
  await client.question.reply(
    {
      requestID: input.requestID,
      answers: input.answers,
      ...(input.directory ? { directory: input.directory } : {}),
    },
    { throwOnError: true },
  )
}

export async function rejectQuestion(client: DeepAgentCodeClient, input: QuestionRoute) {
  if (input.v2) {
    await client.v2.session.question.reject(
      { sessionID: input.sessionID, requestID: input.requestID },
      { throwOnError: true },
    )
    return
  }
  await client.question.reject(
    {
      requestID: input.requestID,
      ...(input.directory ? { directory: input.directory } : {}),
    },
    { throwOnError: true },
  )
}
