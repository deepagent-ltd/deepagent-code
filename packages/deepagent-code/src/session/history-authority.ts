import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { Identifier } from "@deepagent-code/core/util/identifier"
import type { SessionV1 } from "@deepagent-code/core/v1/session"

export const PROJECTION_VERSION = 1
export const CANONICALIZATION_VERSION = 1

export function hash(messages: readonly SessionV1.WithParts[]) {
  return `eh${CANONICALIZATION_VERSION}_${Hash.sha256(
    CanonicalJson.stringify({
      canonicalizationVersion: CANONICALIZATION_VERSION,
      projectionVersion: PROJECTION_VERSION,
      messages: messages.map((message) => ({
        info:
          message.info.role === "user"
            ? {
                id: message.info.id,
                role: message.info.role,
                format: message.info.format,
                // SessionSummary updates UI diff metadata asynchronously after a turn settles.
                // It is not provider prompt input and must not invalidate an immutable window.
                agent: message.info.agent,
                model: message.info.model,
                system: message.info.system,
                tools: message.info.tools,
                metadata: message.info.metadata,
              }
            : {
                id: message.info.id,
                role: message.info.role,
                error: message.info.error,
                parentID: message.info.parentID,
                modelID: message.info.modelID,
                providerID: message.info.providerID,
                providerAttemptID: message.info.providerAttemptID,
                mode: message.info.mode,
                agent: message.info.agent,
                path: message.info.path,
                summary: message.info.summary,
                structured: message.info.structured,
                variant: message.info.variant,
                finish: message.info.finish,
              },
        parts: message.parts.map((part) =>
          Object.fromEntries(
            Object.entries(part).filter(([key]) => key !== "sessionID" && key !== "messageID" && key !== "time"),
          ),
        ),
      })),
    }),
  )}`
}

export function windowID() {
  return `win_${Identifier.ascending()}`
}

export function legacyWindowID(sessionID: string, epoch: number) {
  return `win_${Hash.sha256(`legacy-window:v1:${sessionID}:${epoch}`).slice(0, 26)}`
}

export * as HistoryAuthority from "./history-authority"
