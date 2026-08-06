import { Data } from "effect"
import { SessionID } from "./schema"

export class Stale extends Data.TaggedError("SessionMutationEpoch.Stale")<{
  readonly sessionID: SessionID
  readonly observed: number
  readonly current: number
}> {}

export * as SessionMutationEpoch from "./mutation-epoch"
