import { Context } from "effect"

// Each listener supplies facts from its own bound server. Embedded Web requests have
// no transport authority; request URLs and forwarding headers cannot supply it.
export const ListenerTransport = Context.Reference<{
  readonly secure: boolean
  readonly tlsOrigin: () => string | undefined
  readonly ownsTLSRequest: (source: unknown) => boolean
} | undefined>("@deepagent-code/ListenerTransport", { defaultValue: () => undefined })
