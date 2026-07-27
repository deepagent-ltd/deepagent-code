// Sleep prevention predates the settings toggle, so an unset key must keep the historical
// always-on behavior; only an explicit `false` opts out. Kept Electron-free so the decision
// can be unit-tested without the runtime (same split as close-to-tray.ts).
export function resolvePreventSleepEnabled(stored: unknown): boolean {
  return stored !== false
}
