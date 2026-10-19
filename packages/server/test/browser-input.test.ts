import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Option } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { withBrowserUserInput } from "../src/browser-input"

const run = (header?: string, sessionID = "ses_owner", inputID = "msg_owner") =>
  Effect.runPromise(Effect.exit(withBrowserUserInput(sessionID, inputID)(Effect.succeed("ordinary-prompt"))).pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request("http://127.0.0.1/api/v1/session/ses_owner/prompt", {
        method: "POST", headers: header ? { "x-dac-user-input": header } : {},
      }))),
  ))
const error = (result: Awaited<ReturnType<typeof run>>) => Exit.isFailure(result)
  ? Option.getOrUndefined(Cause.findErrorOption(result.cause)) : undefined
const stamp = {
  originalSubmissionID: "original-owner-input", inputID: "msg_owner", rootSessionID: "ses_owner",
  rawInputHash: "a".repeat(64), promptHash: "b".repeat(64), sourceKind: "gui_composer",
  sourceBindingHash: "c".repeat(64), mainIncarnation: "unregistered-main", submissionOrder: 1,
}

test("ordinary prompts do not require a native browser owner bridge", async () => {
  expect(await run()).toEqual(Exit.succeed("ordinary-prompt"))
})

test("a forged owner envelope cannot authorize a prompt without the actual private Main host", async () => {
  const result = await run(Buffer.from(JSON.stringify(stamp)).toString("base64url"))
  expect(error(result)?._tag).toBe("ServiceUnavailableError")
})

test("owner input envelopes remain exact to Session and input across transport retries", async () => {
  const encoded = Buffer.from(JSON.stringify(stamp)).toString("base64url")
  expect(error(await run(encoded, "ses_other"))?._tag).toBe("InvalidRequestError")
  expect(error(await run(encoded, "ses_owner", "msg_other"))?._tag).toBe("InvalidRequestError")
  expect(error(await run(encoded + "="))?._tag).toBe("InvalidRequestError")
  expect(error(await run("a".repeat(8193)))?._tag).toBe("InvalidRequestError")
})
