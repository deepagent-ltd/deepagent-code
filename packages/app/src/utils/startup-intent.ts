/**
 * Startup intent snapshot — persists the user's last active session to localStorage
 * so the renderer can navigate directly to it on next launch without waiting for
 * server-side persisted state to load.
 *
 * Written synchronously every time the user navigates to a session tab.
 * Read synchronously at startup (before any server request).
 */

const STARTUP_INTENT_KEY = "deepagent:startup-intent"
/** Ignore intents older than 24 h (user may have switched projects externally). */
const INTENT_MAX_AGE_MS = 24 * 60 * 60 * 1000

export type StartupIntent = {
  /** ServerConnection.Key — e.g. "local" or "server:<gatewayUrl>" */
  server: string
  /** Absolute filesystem path of the project directory */
  directory: string
  /** Session ID to restore (may be stale; the session page will handle that gracefully) */
  sessionId: string
  /** Unix timestamp (ms) when this intent was written */
  at: number
}

/**
 * Persist the user's current session as the startup intent.
 * Synchronous — safe to call on every tab navigation (< 0.1 ms).
 */
export function writeStartupIntent(intent: StartupIntent): void {
  try {
    localStorage.setItem(STARTUP_INTENT_KEY, JSON.stringify(intent))
  } catch {
    // localStorage unavailable (private browsing, quota, etc.) — silently ignore
  }
}

/**
 * Read the startup intent written by a previous session.
 * Returns null if none exists, it is malformed, or it is older than 24 h.
 * Synchronous — safe to call during component initialisation.
 */
export function readStartupIntent(): StartupIntent | null {
  try {
    const raw = localStorage.getItem(STARTUP_INTENT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StartupIntent>
    if (
      typeof parsed.server !== "string" ||
      typeof parsed.directory !== "string" ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.at !== "number"
    ) {
      return null
    }
    if (Date.now() - parsed.at > INTENT_MAX_AGE_MS) return null
    return parsed as StartupIntent
  } catch {
    return null
  }
}

/**
 * How fresh an intent must be for the StartupSplashGate to honour it for
 * immediate navigation (separate from the 24 h existence window). If the app
 * was last used > 30 s ago the gate still preloads but uses the tabs fallback
 * for the final navigate (avoids navigating to a stale session after e.g. a
 * reboot). The 24 h window keeps the intent available for warmup preloading.
 */
export const INTENT_NAVIGATE_WINDOW_MS = 30_000
