import { powerSaveBlocker } from "electron"

import { resolvePreventSleepEnabled } from "./prevent-sleep"
import { getStore } from "./store"
import { PREVENT_SLEEP_KEY } from "./store-keys"

// prevent-app-suspension keeps the system/app from idling to sleep while allowing the display to
// turn off (go dark) and the lid to close — i.e. it blocks idle sleep & hibernate, not screen blank.
let blockerId: number | null = null

export function getPreventSleepEnabled(): boolean {
  return resolvePreventSleepEnabled(getStore().get(PREVENT_SLEEP_KEY))
}

export function setPreventSleepEnabled(enabled: boolean): void {
  getStore().set(PREVENT_SLEEP_KEY, enabled)
  if (enabled) {
    startPowerSaveBlocker()
    return
  }
  stopPowerSaveBlocker()
}

export function initPowerSaveBlocker(): void {
  if (!getPreventSleepEnabled()) return
  startPowerSaveBlocker()
}

export function startPowerSaveBlocker(): void {
  if (blockerId !== null) return
  blockerId = powerSaveBlocker.start("prevent-app-suspension")
}

export function stopPowerSaveBlocker(): void {
  if (blockerId === null) return
  if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId)
  blockerId = null
}
