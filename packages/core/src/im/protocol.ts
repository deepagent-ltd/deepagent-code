/**
 * The IM / session wire-protocol contract version.
 *
 * Bumped when the WebSocket event shapes, IM HTTP payloads, or session
 * streaming contract change in a way a client must be aware of. Reported by the
 * data-plane `/global/capabilities` endpoint so Server Edition clients can
 * verify compatibility before driving the app.
 *
 * Keep in sync with the documented protocol version in the IM design doc.
 */
export const IM_PROTOCOL_VERSION = "3.8"
