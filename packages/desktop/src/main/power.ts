import { powerSaveBlocker } from "electron"

// prevent-app-suspension keeps the system/app from idling to sleep while allowing the display to
// turn off (go dark) and the lid to close — i.e. it blocks idle sleep & hibernate, not screen blank.
let blockerId: number | null = null

export function startPowerSaveBlocker(): void {
  if (blockerId !== null) return
  blockerId = powerSaveBlocker.start("prevent-app-suspension")
}

export function stopPowerSaveBlocker(): void {
  if (blockerId === null) return
  if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId)
  blockerId = null
}
