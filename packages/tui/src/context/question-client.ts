import type { OpencodeClient, QuestionAnswer, QuestionRequest } from "@deepagent-code/sdk"

export namespace QuestionClient {
  export type Target = {
    request: QuestionRequest
    v2: boolean
    directory?: string
  }

  export function reply(client: OpencodeClient, target: Target, answers: QuestionAnswer[]) {
    if (target.v2)
      return client.v2.session.question.reply(
        {
          sessionID: target.request.sessionID,
          requestID: target.request.id,
          questionV2Reply: { answers },
        },
        { throwOnError: true },
      )
    return client.question.reply(
      { requestID: target.request.id, directory: target.directory, answers },
      { throwOnError: true },
    )
  }

  export function reject(client: OpencodeClient, target: Target) {
    if (target.v2)
      return client.v2.session.question.reject(
        { sessionID: target.request.sessionID, requestID: target.request.id },
        { throwOnError: true },
      )
    return client.question.reject({ requestID: target.request.id, directory: target.directory }, { throwOnError: true })
  }
}
