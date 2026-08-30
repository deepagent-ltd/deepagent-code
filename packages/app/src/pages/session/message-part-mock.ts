import { mock } from "bun:test"
import type { Part } from "@deepagent-code/sdk/client"

// Complete export surface of @deepagent-code/ui/message-part as consumed by the
// message-timeline graph (message-timeline.tsx + message-timeline.data.ts).
// Bun validates the imported names against the ACTIVE mock table at compile
// time, so a partial mock makes message-timeline.tsx fail with "Export named
// 'MessageDivider' not found in module" whenever it is compiled in a worker
// that installed the mock — which the virtualize test triggers via its
// deferred `import("./message-timeline")`. Keep this list in sync with the
// imports in message-timeline.tsx / message-timeline.data.ts.
const component = () => null

export function mockMessagePart({
  renderable = () => true,
}: {
  renderable?: (part: Part, showReasoningSummaries?: boolean) => boolean
} = {}) {
  mock.module("@deepagent-code/ui/message-part", () => ({
    groupParts: (refs: { messageID: string; part: Part }[]) =>
      refs.map((item) => ({
        key: `part:${item.messageID}:${item.part.id}`,
        type: "part",
        ref: { messageID: item.messageID, partID: item.part.id },
      })),
    renderable,
    ContextToolGroup: component,
    Message: component,
    MessageDivider: component,
    Part: component,
    partDefaultOpen: () => true,
  }))
}
