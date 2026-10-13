import { expect, test } from "bun:test"
import { Effect } from "effect"
import { LocalOperatorSchema } from "@deepagent-code/core/im/local-operator.schema"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { LocalOperatorPolicy } from "../../src/im/local-operator-policy"

const target = { id: "target-one", directory: "/private/absent-kernel-policy-fixture", agentID: "auto", providerID: "fixture", modelID: "probe",
  budget: { ...WorkAuthorityPolicy.TEXT_ONLY_PROFILE.budget } }
const issuedAt = Date.now()
const receiver = { id: "receiver-one", targetID: target.id, realmID: "https://kernel.example/", appkeyID: "public-app", orgID: 17,
  receiverID: "platform-receiver", localUserID: "server" as const, issuedAt, expiresAt: issuedAt + LocalOperatorSchema.KERNEL_RECEIVER_LIFETIME_MS }
const parse = (input: unknown) => Effect.runPromise(LocalOperatorPolicy.parse(input))

test("strict operator policy files preserve explicit fixed receiver mappings and leave absent mappings absent", async () => {
  for (const version of [1, 5] as const) {
    const ordinary = { version, targets: [target] }
    expect(await parse(ordinary)).toEqual(ordinary)
    const mapped = { ...ordinary, kernelReceivers: [receiver] }
    expect(await parse(mapped)).toEqual(mapped)
  }
})

test("caller proof flags, credential-bearing realms and altered lifetime cannot enter operator policy", async () => {
  for (const changed of [
    { ...receiver, verified: true }, { ...receiver, credentialFingerprint: "a".repeat(64) },
    { ...receiver, localUserID: "foreign-viewer" }, { ...receiver, realmID: "https://user:secret@kernel.example/" },
    { ...receiver, realmID: "https://kernel.example/?token=secret" }, { ...receiver, realmID: "https://kernel.example" },
    { ...receiver, expiresAt: receiver.expiresAt + 1 }, { ...receiver, orgID: Number.MAX_SAFE_INTEGER + 1 },
  ]) await expect(parse({ version: 5, targets: [target], kernelReceivers: [changed] })).rejects.toMatchObject({ code: "LOCAL_OPERATOR_INVALID" })
})
